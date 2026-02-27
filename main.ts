import type * as github from "@actions/github";
import type { Octokit } from "@octokit/rest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface Logger {
  info(m: string): void;
}

export type Options = {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  rootDir?: string;
  empty?: boolean; // if true, create an empty commit
  files?: string[];
  baseSHA?: string; // By default, the base branch's latest commit is used
  baseBranch?: string; // By default, if branch exists, it is used as the base branch. Otherwise, the default branch is used
  noParent?: boolean; // if true, do not use parent commit
  deletedFiles?: string[]; // files to delete
  deleteIfNotExist?: boolean; // if true, delete files if they don't exist
  forcePush?: boolean; // if true, force push the commit
  logger?: Logger;
};

// Created commit, base ref
export type Result = {
  commit: {
    sha: string;
  };
};

export type GitHub = Octokit | ReturnType<typeof github.getOctokit>;

export const createCommit = async (
  octokit: GitHub,
  opts: Options,
): Promise<Result | undefined> => {
  if (!opts.files?.length && !opts.deletedFiles?.length && !opts.empty) {
    // If no files are passed and empty is false, do nothing
    return undefined;
  }
  validateOptions(opts);
  const logger = opts.logger || {
    info: (message: string) => console.info(message),
  };
  const baseBranch = await getBaseBranch(octokit, logger, opts);
  const treeSHA = await getTreeSHA(octokit, opts, baseBranch, logger);
  // Create a commit
  const parents = opts.noParent ? undefined : [baseBranch.target.oid];
  logger.info(
    `creating a commit: owner=${opts.owner} repo=${opts.repo} tree=${treeSHA} parents=${parents}`,
  );
  const commit = await octokit.rest.git.createCommit({
    owner: opts.owner,
    repo: opts.repo,
    message: opts.message,
    tree: treeSHA,
    parents: parents,
  });
  try {
    // Update the reference if the branch exists
    return await updateRef(octokit, opts, commit.data.sha, logger);
  } catch (error: unknown) {
    if (!isError(error)) {
      throw error;
    }
    if (!error.message.includes("Reference does not exist")) {
      throw error;
    }
    // Create a reference if the branch does not exist
    return await createRef(octokit, opts, commit.data.sha, logger);
  }
};

// Node.js hasn't supported Error.isError yet.
const isError = (value: unknown): value is Error => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const error = value as Record<keyof Error, unknown>;
  if (typeof error.message !== "string") {
    return false;
  }
  return true;
};

type Error = {
  message: string;
};

type FileType = "blob" | "tree" | "commit";

type FileMode = "100644" | "100755" | "040000" | "160000" | "120000";

type File = {
  path: string;
  content?: string;
  sha?: string | null;
  mode: FileMode;
  type?: FileType;
};

type DefaultBranchResponse = {
  repository: {
    defaultBranchRef: Ref;
  };
};

const updateRef = async (
  octokit: GitHub,
  opts: Options,
  sha: string,
  logger: Logger,
): Promise<Result> => {
  // Update the reference if the branch exists
  logger.info(
    `updating a ref: owner=${opts.owner} repo=${opts.repo} ref=heads/${opts.branch} sha=${sha} force=${
      opts.forcePush || false
    }`,
  );
  const updatedRef = await octokit.rest.git.updateRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: `heads/${opts.branch}`,
    sha: sha,
    force: opts.forcePush || false, // Use force push if specified
  });
  return {
    commit: {
      sha: updatedRef.data.object.sha,
    },
  };
};

const createRef = async (
  octokit: GitHub,
  opts: Options,
  sha: string,
  logger: Logger,
): Promise<Result> => {
  logger.info(
    `creating a ref: owner=${opts.owner} repo=${opts.repo} ref=refs/heads/${opts.branch} sha=${sha}`,
  );
  const createdRef = await octokit.rest.git.createRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: `refs/heads/${opts.branch}`,
    sha: sha,
  });
  return {
    commit: {
      sha: createdRef.data.object.sha,
    },
  };
};

const getTreeSHA = async (
  octokit: GitHub,
  opts: Options,
  baseBranch: Ref,
  logger: Logger,
): Promise<string> => {
  if (opts.empty) {
    return baseBranch.target.tree.oid;
  }
  const tree: File[] = [];
  for (const filePath of opts.files || []) {
    tree.push(await createTreeFile(opts, filePath));
  }
  for (const filePath of opts.deletedFiles || []) {
    tree.push(await createDeletedTreeFile(opts, filePath));
  }
  const baseTree = opts.noParent ? undefined : baseBranch.target.tree.oid;
  logger.info(
    `creating a tree with ${tree.length} files: owner=${opts.owner} repo=${opts.repo} base_tree=${baseTree}`,
  );
  const treeResp = await octokit.rest.git.createTree({
    owner: opts.owner,
    repo: opts.repo,
    tree: tree,
    // If not provided, GitHub will create a new Git tree object from only the entries defined in the tree parameter.
    // If you create a new commit pointing to such a tree, then all files which were a part of the parent commit's tree and were not defined in the tree parameter will be listed as deleted by the new commit.
    base_tree: baseTree,
  });
  return treeResp.data.sha;
};

const validateOptions = (opts: Options) => {
  for (const key of ["owner", "repo", "branch", "message"] as const) {
    // Check required options
    if (!opts[key]) {
      throw new Error(`${key} is required`);
    }
  }
};

const getFileType = (mode: FileMode): FileType => {
  // https://octokit.github.io/rest.js/v22/#git-create-tree
  // The file mode;
  // one of 100644 for file (blob),
  // 100755 for executable (blob),
  // 040000 for subdirectory (tree),
  // 160000 for submodule (commit),
  // or 120000 for a blob that specifies the path of a symlink.
  switch (mode) {
    case "100644":
      return "blob";
    case "100755":
      return "blob";
    case "040000":
      return "tree";
    case "160000":
      return "commit";
    case "120000":
      return "blob";
  }
};

const createTreeFile = async (
  opts: Options,
  filePath: string,
): Promise<File> => {
  const file = await getFileContentAndMode(
    path.join(opts.rootDir || "", filePath),
    opts.deleteIfNotExist || false,
  );
  return {
    path: filePath,
    sha: file.sha,
    mode: file.mode,
    type: getFileType(file.mode),
    content: file.content,
  };
};

const createDeletedTreeFile = async (
  opts: Options,
  filePath: string,
): Promise<File> => {
  const file = await getFileContentAndMode(
    path.join(opts.rootDir || "", filePath),
    opts.deleteIfNotExist || false,
  );
  return {
    path: filePath,
    mode: file.mode,
    type: getFileType(file.mode),
    sha: null,
  };
};

const getBaseBranch = async (
  octokit: GitHub,
  logger: Logger,
  opts: Options,
): Promise<Ref> => {
  if (opts.baseSHA) {
    return {
      target: {
        oid: opts.baseSHA,
        tree: {
          oid: await getTree(octokit, opts.owner, opts.repo, opts.baseSHA),
        },
      },
    };
  }
  if (opts.baseBranch) {
    logger.info(
      `getting the base branch: owner=${opts.owner} repo=${opts.repo} branch=${opts.baseBranch}`,
    );
    const branch = await getBranch(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      branch: opts.baseBranch,
    });
    if (branch === undefined) {
      throw new Error(
        `Branch ${opts.branch} does not exist in ${opts.owner}/${opts.repo}`,
      );
    }
    return branch;
  }
  // Check if the specified branch exists
  logger.info(
    `getting the branch: owner=${opts.owner} repo=${opts.repo} branch=${opts.branch}`,
  );
  const branch = await getBranch(octokit, {
    owner: opts.owner,
    repo: opts.repo,
    branch: opts.branch,
  });

  if (branch) {
    return branch;
  }
  logger.info(
    `getting the default branch: owner=${opts.owner} repo=${opts.repo}`,
  );
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

type Err = {
  code: string;
};

const resolvePackedRef = async (
  gitDir: string,
  ref: string,
): Promise<string> => {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  const content = await readFile(packedRefsPath, "utf8");
  for (const line of content.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }
    const [sha, packedRef] = line.split(" ", 2);
    if (packedRef === ref) {
      return sha;
    }
  }
  throw new Error(`ref ${ref} not found in packed-refs`);
};

const resolveGitHEAD = async (gitDir: string): Promise<string> => {
  const headPath = path.join(gitDir, "HEAD");
  const content = (await readFile(headPath, "utf8")).trim();
  // Detached HEAD: content is a SHA
  if (!content.startsWith("ref: ")) {
    return content;
  }
  // Symbolic ref: resolve the ref file
  const ref = content.slice("ref: ".length);
  const refPath = path.join(gitDir, ref);
  try {
    return (await readFile(refPath, "utf8")).trim();
  } catch {
    // ref file doesn't exist, try packed-refs
    return resolvePackedRef(gitDir, ref);
  }
};

const getSubmoduleCommitSHA = async (
  dirPath: string,
): Promise<string | undefined> => {
  const dotGitPath = path.join(dirPath, ".git");
  try {
    const stats = await stat(dotGitPath);
    if (!stats.isFile()) {
      // .git is a directory (regular repo, not a submodule)
      return undefined;
    }
  } catch {
    // .git doesn't exist
    return undefined;
  }
  // .git is a file → this is a submodule
  const content = (await readFile(dotGitPath, "utf8")).trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return undefined;
  }
  const gitDir = path.isAbsolute(match[1])
    ? match[1]
    : path.resolve(dirPath, match[1]);
  return resolveGitHEAD(gitDir);
};

const getFileContentAndMode = async (
  filePath: string,
  deleteIfNotExist: boolean,
): Promise<File> => {
  if (!deleteIfNotExist) {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      const commitSHA = await getSubmoduleCommitSHA(filePath);
      if (commitSHA !== undefined) {
        return {
          path: filePath,
          mode: "160000",
          type: "commit",
          sha: commitSHA,
        };
      }
      return {
        path: filePath,
        mode: "040000",
        type: "tree",
      };
    }
    const mode = getFileMode(stats.mode);
    return {
      path: filePath,
      content: await readFile(filePath, "utf8"),
      mode: mode,
      type: getFileType(mode),
    };
  }
  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      const commitSHA = await getSubmoduleCommitSHA(filePath);
      if (commitSHA !== undefined) {
        return {
          path: filePath,
          mode: "160000",
          type: "commit",
          sha: commitSHA,
        };
      }
      return {
        path: filePath,
        mode: "040000",
        type: "tree",
      };
    }
    const content = await readFile(filePath, "utf8");
    const mode = getFileMode(stats.mode);
    return {
      path: filePath,
      content,
      mode: mode,
      type: getFileType(mode),
    };
  } catch (error: unknown) {
    if (typeof error !== "object" || error === undefined) {
      throw error;
    }
    const err = error as Record<keyof Err, unknown>;
    if (typeof err.code !== "string" || err.code !== "ENOENT") {
      throw error;
    }
    // If the file does not exist, remove the file
    const mode = "100644";
    return {
      sha: null,
      path: filePath,
      mode: mode,
      type: getFileType(mode),
    };
  }
};

const getFileMode = (mode: number): FileMode => {
  const type = mode & 0o170000;
  const perm = mode & 0o777;

  switch (type) {
    case 0o100000: // regular file
      return perm & 0o111 ? "100755" : "100644";
    case 0o040000: // directory
      return "040000";
    case 0o160000: // gitlink (submodule)
      return "160000";
    case 0o120000: // symlink
      return "120000";
    default:
      return "100644";
  }
};

type getTreeResponse = {
  repository: {
    object: {
      tree: {
        oid: string;
      };
    };
  };
};

const getTree = async (
  octokit: GitHub,
  owner: string,
  repo: string,
  oid: string,
): Promise<string> => {
  // Get the branch
  const resp = await octokit.graphql<getTreeResponse>(
    `query($owner: String!, $repo: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) {
      ... on Commit {
        tree {
          oid
        }
      }
    }
  }
}`,
    {
      owner: owner,
      repo: repo,
      oid: oid,
    },
  );
  return resp.repository.object.tree.oid;
};
