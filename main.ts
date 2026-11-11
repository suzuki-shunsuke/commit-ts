import type * as github from "@actions/github";
import type { Octokit } from "@octokit/rest";
import { Buffer } from "node:buffer";
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
  useBaseTree?: boolean; // if true, use base branch's tree as base_tree. Defaults to !noParent
  deletedFiles?: string[]; // files to delete
  deleteIfNotExist?: boolean; // if true, delete files if they don't exist
  submodules?: Array<{ path: string; sha: string }>; // submodule entries to add to the tree
  // symlink entries to add to the tree.
  // target is the link target (the result of readlink(2)), which is stored as the blob content with mode 120000.
  // The file system isn't accessed, so dangling symlinks are supported.
  // target is sent as a UTF-8 string, so a target that isn't valid UTF-8 can't be stored as is.
  // A symlink path must not be passed to files, deletedFiles, or submodules.
  symlinks?: Symlink[];
  forcePush?: boolean; // if true, force push the commit
  logger?: Logger;
};

export type Symlink = {
  path: string;
  target: string;
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
  if (
    !opts.files?.length && !opts.deletedFiles?.length &&
    !opts.submodules?.length && !opts.symlinks?.length && !opts.empty
  ) {
    // If nothing to commit is passed and empty is false, do nothing
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
  sha?: string;
  mode: FileMode;
  type: FileType;
};

type DeletedFile = {
  path: string;
  sha: null;
  mode: FileMode;
};

type TreeEntry = File | DeletedFile;

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
  let tree: TreeEntry[] = [];
  for (const filePath of opts.files || []) {
    tree.push(await createTreeFile(octokit, opts, filePath));
  }
  for (const filePath of opts.deletedFiles || []) {
    tree.push(createDeletedTreeFile(filePath));
  }
  for (const sub of opts.submodules || []) {
    tree.push({
      path: sub.path,
      mode: "160000",
      type: "commit",
      sha: sub.sha,
    });
  }
  for (const symlink of opts.symlinks || []) {
    tree.push(createSymlinkTreeEntry(symlink));
  }
  validateTree(tree);
  tree = removeDeletionsUnderSymlinks(tree);
  const useBaseTree = opts.useBaseTree ?? !opts.noParent;
  const baseTree = useBaseTree ? baseBranch.target.tree.oid : undefined;
  try {
    return await createTree(octokit, opts, tree, baseTree, logger);
  } catch (error: unknown) {
    if (!baseTree || !isBadObjectState(error)) {
      throw error;
    }
    // A path may be added under a file or a symlink in the base tree,
    // i.e. a file or a symlink replaced with a directory.
    // It's checked only on this error to avoid extra API calls.
    let replaced: string[];
    try {
      replaced = await findReplacedParents(octokit, opts, baseTree, tree);
    } catch (findError: unknown) {
      if (isError(findError) && findError.message.includes("submodule")) {
        throw findError;
      }
      // Don't hide the original error
      logger.info(
        `failed to check if files in the base tree are replaced with directories: ${
          isError(findError) ? findError.message : findError
        }`,
      );
      throw error;
    }
    if (replaced.length === 0) {
      throw error;
    }
    for (const parent of replaced) {
      logger.info(
        `deleting ${parent}, which is a file or a symlink in the base tree, to add paths under it`,
      );
    }
    return await createTree(
      octokit,
      opts,
      replaceParents(tree, replaced),
      baseTree,
      logger,
    );
  }
};

const createTree = async (
  octokit: GitHub,
  opts: Options,
  tree: TreeEntry[],
  baseTree: string | undefined,
  logger: Logger,
): Promise<string> => {
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

/**
 * @internal Exported for tests.
 *
 * Returns the tree with deletions of the replaced parents put first.
 * Deletions under the replaced parents are removed: they don't exist in the
 * base tree because the parents are files or symlinks there, and the Create a
 * tree API fails with GitRPC::BadObjectState when deleting a missing path.
 */
export const replaceParents = (
  tree: TreeEntry[],
  replaced: string[],
): TreeEntry[] => {
  return [
    ...replaced.map(createDeletedTreeFile),
    ...removeDeletionsUnder(tree, new Set(replaced)),
  ];
};

const isBadObjectState = (error: unknown): boolean =>
  isError(error) && error.message.includes("BadObjectState");

/**
 * @internal Exported for tests.
 *
 * Validate options before any API call or file access.
 */
export const validateOptions = (opts: Options): void => {
  for (const key of ["owner", "repo", "branch", "message"] as const) {
    // Check required options
    if (!opts[key]) {
      throw new Error(`${key} is required`);
    }
  }
  validateSymlinks(opts);
};

const validateSymlinks = (opts: Options) => {
  if (!opts.symlinks?.length) {
    return;
  }
  // A path must not be passed twice, otherwise the tree has two entries for the same path.
  const otherPaths = new Set([
    ...(opts.files || []),
    ...(opts.deletedFiles || []),
    ...(opts.submodules || []).map((sub) => sub.path),
  ]);
  const symlinkPaths = new Set<string>();
  for (const symlink of opts.symlinks) {
    if (!symlink.path) {
      throw new Error("symlink path is required");
    }
    if (!symlink.target) {
      throw new Error(`symlink target is required: ${symlink.path}`);
    }
    if (symlinkPaths.has(symlink.path)) {
      throw new Error(`symlink path is duplicated: ${symlink.path}`);
    }
    if (otherPaths.has(symlink.path)) {
      throw new Error(
        `symlink path must not be passed to files, deletedFiles, or submodules: ${symlink.path}`,
      );
    }
    symlinkPaths.add(symlink.path);
  }
};

/**
 * @internal Exported for tests.
 *
 * Validate the tree entries before calling the Create a tree API.
 *
 * A symlink can't contain other paths, and a symlink can't be under a file or a submodule.
 * This is checked after the entries are built, because whether an entry of files is
 * a deletion, a file, a directory, or a submodule is decided by accessing the file system.
 * Deletions are allowed under a symlink, e.g. when a directory is replaced with a symlink.
 * They are removed by removeDeletionsUnderSymlinks.
 * Only entries related to symlinks are checked to keep the behavior without symlinks.
 */
export const validateTree = (tree: TreeEntry[]): void => {
  const symlinkPaths = getSymlinkPaths(tree);
  if (symlinkPaths.size === 0) {
    return;
  }
  // Paths which can't contain other paths
  const leafPaths = new Set(
    tree.filter((e) => e.sha !== null && e.mode !== "040000").map((e) =>
      e.path
    ),
  );
  for (const entry of tree) {
    if (entry.sha === null) {
      continue;
    }
    for (const parent of parentDirs(entry.path)) {
      if (symlinkPaths.has(parent)) {
        throw new Error(
          `${entry.path} must not be under the symlink ${parent}`,
        );
      }
      if (symlinkPaths.has(entry.path) && leafPaths.has(parent)) {
        throw new Error(
          `the symlink ${entry.path} must not be under ${parent}, which isn't a directory`,
        );
      }
    }
  }
};

/**
 * @internal Exported for tests.
 *
 * Remove deletions under symlinks.
 *
 * When a directory is replaced with a symlink, the symlink entry replaces the whole directory,
 * so deletions of files in the directory are redundant.
 * Moreover, the Create a tree API fails with GitRPC::BadObjectState if only some files
 * in the directory are deleted along with the symlink.
 */
export const removeDeletionsUnderSymlinks = (
  tree: TreeEntry[],
): TreeEntry[] => {
  return removeDeletionsUnder(tree, getSymlinkPaths(tree));
};

// removeDeletionsUnder removes deletions of paths under the given paths.
const removeDeletionsUnder = (
  tree: TreeEntry[],
  paths: Set<string>,
): TreeEntry[] => {
  if (paths.size === 0) {
    return tree;
  }
  return tree.filter((e) =>
    e.sha !== null ||
    !parentDirs(e.path).some((parent) => paths.has(parent))
  );
};

const getSymlinkPaths = (tree: TreeEntry[]): Set<string> =>
  new Set(
    tree.filter((e) => e.sha !== null && e.mode === "120000").map((e) =>
      e.path
    ),
  );

/**
 * @internal Exported for tests.
 *
 * Returns the parent directories of the entries which add paths, excluding
 * paths which are entries of the tree themselves (e.g. already deleted).
 */
export const listParentDirs = (tree: TreeEntry[]): string[] => {
  const paths = new Set(tree.map((e) => e.path));
  const parents = new Set<string>();
  for (const entry of tree) {
    if (entry.sha === null) {
      continue;
    }
    for (const parent of parentDirs(entry.path)) {
      if (!paths.has(parent)) {
        parents.add(parent);
      }
    }
  }
  return [...parents];
};

/**
 * @internal Exported for tests.
 *
 * Returns the parents which are files or symlinks (Blob) in the base tree.
 * typenames maps a parent to the GraphQL typename of the object at the path
 * in the base tree (Blob, Tree, or Commit for a submodule), or null if the
 * path doesn't exist.
 * It throws an error if a parent is a submodule, because a path under a
 * submodule can't be added.
 */
export const pickReplacedParents = (
  typenames: Map<string, string | null>,
): string[] => {
  const replaced: string[] = [];
  for (const [parent, typename] of typenames) {
    if (typename === "Blob") {
      replaced.push(parent);
    } else if (typename === "Commit") {
      throw new Error(
        `${parent} is a submodule in the base tree, so paths under it can't be added`,
      );
    }
  }
  return replaced;
};

// The number of paths queried by one GraphQL request
const treeQueryChunkSize = 100;

/**
 * Returns the parent directories of added paths which are files or symlinks
 * in the base tree, i.e. files or symlinks replaced with directories.
 *
 * The Create a tree API can't add a path under a file or a symlink in the
 * base tree (GitRPC::BadObjectState), so they must be deleted explicitly.
 * The base tree is checked by the API, because the caller's working tree can
 * differ from the base tree.
 */
const findReplacedParents = async (
  octokit: GitHub,
  opts: Options,
  baseTree: string,
  tree: TreeEntry[],
): Promise<string[]> => {
  const parents = listParentDirs(tree);
  const typenames = new Map<string, string | null>();
  for (let i = 0; i < parents.length; i += treeQueryChunkSize) {
    const chunk = parents.slice(i, i + treeQueryChunkSize);
    const variables: Record<string, string> = {
      owner: opts.owner,
      repo: opts.repo,
    };
    chunk.forEach((parent, j) => {
      variables[`p${j}`] = `${baseTree}:${parent}`;
    });
    const resp = await octokit.graphql<{
      repository: Record<string, { __typename: string } | null>;
    }>(
      `query($owner: String!, $repo: String!, ${
        chunk.map((_, j) => `$p${j}: String!`).join(", ")
      }) {
  repository(owner: $owner, name: $repo) {
    ${
        chunk.map((_, j) => `p${j}: object(expression: $p${j}) { __typename }`)
          .join("\n    ")
      }
  }
}`,
      variables,
    );
    chunk.forEach((parent, j) => {
      typenames.set(parent, resp.repository[`p${j}`]?.__typename ?? null);
    });
  }
  return pickReplacedParents(typenames);
};

// parentDirs("a/b/c") returns ["a", "a/b"].
const parentDirs = (p: string): string[] => {
  const elems = p.split("/");
  return elems.slice(1).map((_, i) => elems.slice(0, i + 1).join("/"));
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
  octokit: GitHub,
  opts: Options,
  filePath: string,
): Promise<TreeEntry> => {
  const file = await getFileContentAndMode(
    octokit,
    opts,
    path.join(opts.rootDir || "", filePath),
    opts.deleteIfNotExist || false,
  );
  if (file.sha === null) {
    // mode is required by the Create a tree API even for deletions (sha: null).
    return { path: filePath, sha: null, mode: "100644" };
  }
  return { path: filePath, ...file };
};

/**
 * @internal Exported for tests.
 *
 * A symlink is a blob whose content is the link target, with mode 120000.
 * The symlink must be validated by validateOptions beforehand.
 */
export const createSymlinkTreeEntry = (symlink: Symlink): File => {
  return {
    path: symlink.path,
    mode: "120000",
    type: "blob",
    content: symlink.target,
  };
};

const createDeletedTreeFile = (filePath: string): DeletedFile => ({
  path: filePath,
  sha: null,
  mode: "100644",
});

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

/**
 * @internal Exported for tests.
 *
 * Return the buffer as a UTF-8 string iff the bytes are losslessly
 * representable as UTF-8. `readFile(path, "utf8")` silently replaces invalid
 * bytes with U+FFFD, so roundtripping through `toString("utf8")` and comparing
 * bytes is the reliable way to detect lossy decodes.
 */
export const tryInlineUtf8 = (buf: Buffer): string | undefined => {
  const s = buf.toString("utf8");
  if (Buffer.byteLength(s, "utf8") !== buf.length) return undefined;
  if (!Buffer.from(s, "utf8").equals(buf)) return undefined;
  return s;
};

const createBlobFromBuffer = async (
  octokit: GitHub,
  owner: string,
  repo: string,
  buf: Buffer,
): Promise<string> => {
  const resp = await octokit.rest.git.createBlob({
    owner,
    repo,
    content: buf.toString("base64"),
    encoding: "base64",
  });
  return resp.data.sha;
};

const getFileContentAndMode = async (
  octokit: GitHub,
  opts: Options,
  filePath: string,
  deleteIfNotExist: boolean,
): Promise<Omit<File, "path"> | { sha: null }> => {
  const readRegularFile = async (
    mode: FileMode,
  ): Promise<Omit<File, "path">> => {
    const buf = await readFile(filePath);
    const inline = tryInlineUtf8(buf);
    if (inline !== undefined) {
      return { content: inline, mode, type: getFileType(mode) };
    }
    const sha = await createBlobFromBuffer(octokit, opts.owner, opts.repo, buf);
    return { sha, mode, type: getFileType(mode) };
  };
  if (!deleteIfNotExist) {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      const commitSHA = await getSubmoduleCommitSHA(filePath);
      if (commitSHA !== undefined) {
        return {
          mode: "160000",
          type: "commit",
          sha: commitSHA,
        };
      }
      return {
        mode: "040000",
        type: "tree",
      };
    }
    return readRegularFile(getFileMode(stats.mode));
  }
  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      const commitSHA = await getSubmoduleCommitSHA(filePath);
      if (commitSHA !== undefined) {
        return {
          mode: "160000",
          type: "commit",
          sha: commitSHA,
        };
      }
      return {
        mode: "040000",
        type: "tree",
      };
    }
    return await readRegularFile(getFileMode(stats.mode));
  } catch (error: unknown) {
    if (typeof error !== "object" || error === undefined) {
      throw error;
    }
    const err = error as Record<keyof Err, unknown>;
    if (typeof err.code !== "string" || err.code !== "ENOENT") {
      throw error;
    }
    // If the file does not exist, remove the file
    return { sha: null };
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
