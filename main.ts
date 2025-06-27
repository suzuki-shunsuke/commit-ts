import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { readFile, stat } from "node:fs/promises";

export type Options = {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  empty?: boolean; // if true, create an empty commit
  files?: string[];
  parent?: string;
  noParent?: boolean; // if true, do not use parent commit
  directory?: string;
  deletedFiles?: string[]; // files to delete
  deleteIfNotExist?: boolean; // if true, delete files if they don't exist
  forcePush?: boolean; // if true, force push the commit
};

// Created commit, base ref
export type Result = {
  commit: {
    sha: string;
  };
};

export type GitHub = Octokit | ReturnType<typeof github.getOctokit>;

export const commit = async (
  octokit: GitHub,
  opts: Options,
): Promise<Result|undefined> => {
  if (!opts.files?.length && !opts.empty) {
    return undefined;
  }
  for (const key of ["owner", "repo", "branch", "message"] as const) {
    if (!opts[key]) {
      throw new Error(`${key} is required`);
    }
  }
  const baseBranch = await getBaseBranch(octokit, opts);

  let treeSHA = baseBranch.target.tree.oid;
  if (!opts.empty) {
    const tree: File[] = [];
    for (const filePath of opts.files || []) {
      const file = await getFileContentAndMode(filePath);
      tree.push({
        path: filePath,
        mode: file.mode,
        type: "blob",
        content: file.content,
      });
    }
    const treeResp = await octokit.rest.git.createTree({
      owner: opts.owner,
      repo: opts.repo,
      tree: tree,
      base_tree: baseBranch.target.tree.oid,
    });
    treeSHA = treeResp.data.sha;
  }

  // Create a commit
  const commit = await octokit.rest.git.createCommit({
    owner: opts.owner,
    repo: opts.repo,
    message: opts.message,
    tree: treeSHA,
    parents: opts.parent && [opts.parent] || [baseBranch.target.oid],
  });
  if (baseBranch.name === opts.branch) {
    // Update the reference if the branch exists
    const updatedRef = await octokit.rest.git.updateRef({
      owner: opts.owner,
      repo: opts.repo,
      ref: `heads/${opts.branch}`,
      sha: commit.data.sha,
    });
    return {
      commit: {
        sha: updatedRef.data.object.sha,
      },
    };
  }
  // Create a reference if the branch does not exist
  const createdRef = await octokit.rest.git.createRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: `refs/heads/${opts.branch}`,
    sha: commit.data.sha,
  });
  return {
    commit: {
      sha: createdRef.data.object.sha,
    },
  };
};

type FileMode = "100644" | "100755" | "040000" | "160000" | "120000";

type File = {
  path: string;
  content: string;
  mode?: FileMode;
  type?: "blob" | "tree" | "commit";
};

type DefaultBranchResponse = {
  repository: {
    defaultBranchRef: Ref;
  };
};

const getBaseBranch = async (octokit: GitHub, opts: Options): Promise<Ref> => {
  if (!opts.branch) {
    throw new Error("branch is not specified");
  }

  // Check if the specified branch exists
  const branch = await getBranch(octokit, {
    owner: opts.owner,
    repo: opts.repo,
    branch: opts.branch,
  });

  if (branch) {
    return branch;
  }
  return await getDefaultBranch(octokit, opts);
};

const getDefaultBranch = async (
  octokit: GitHub,
  opts: Options,
): Promise<Ref> => {
  const { repository } = await octokit.graphql<DefaultBranchResponse>(
    `query($owner: String!, $repo: String!) {
     repository(owner: $owner, name: $repo) {
       defaultBranchRef {
         name
         target {
           ... on Commit {
             oid
             tree {
               oid
             }
           } 
         }
       }
     }
   } 
  `,
    {
      owner: opts.owner,
      repo: opts.repo,
    },
  );
  return repository.defaultBranchRef;
};

type getBranchInput = {
  owner: string;
  repo: string;
  branch: string;
};

type Ref = {
  name: string;
  target: {
    oid: string;
    tree: {
      oid: string;
    };
  };
};

type getBranchResponse = {
  repository: {
    ref?: Ref;
  };
};

const getBranch = async (
  octokit: GitHub,
  input: getBranchInput,
): Promise<Ref | undefined> => {
  // Get the branch
  const resp = await octokit.graphql<getBranchResponse>(
    `query($owner: String!, $repo: String!, $ref: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $ref) {
      name
      target {
        ... on Commit {
          oid
          tree {
            oid
          }
        } 
      }
    }
  }
}`,
    {
      owner: input.owner,
      repo: input.repo,
      ref: input.branch,
    },
  );
  return resp.repository.ref;
};

const getFileContentAndMode = async (filePath: string): Promise<File> => {
  const [content, stats] = await Promise.all([
    readFile(filePath, "utf8"),
    stat(filePath),
  ]);

  return {
    path: filePath,
    content,
    mode: getFileMode(stats.mode),
    type: "blob",
  };
};

const getFileMode = (mode: number): FileMode => {
  switch (mode & 0o170000) {
    case 0o100755: // executable file
      return "100755";
    case 0o040000: // directory
      return "040000";
    case 0o160000: // symlink
      return "160000";
    case 0o120000: // gitlink
      return "120000";
    default:
      return "100644";
  }
};
