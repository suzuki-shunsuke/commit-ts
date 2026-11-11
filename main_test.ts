import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Buffer } from "node:buffer";
import {
  createCommit,
  createSymlinkTreeEntry,
  type GitHub,
  listParentDirs,
  type Options,
  pickReplacedParents,
  removeDeletionsUnderSymlinks,
  replaceParents,
  tryInlineUtf8,
  validateOptions,
  validateTree,
} from "./main.ts";

Deno.test("tryInlineUtf8: ASCII", () => {
  const buf = Buffer.from("hello world", "utf8");
  assertEquals(tryInlineUtf8(buf), "hello world");
});

Deno.test("tryInlineUtf8: multi-byte UTF-8 (Japanese + emoji)", () => {
  const original = "こんにちは 🌸";
  const buf = Buffer.from(original, "utf8");
  assertEquals(tryInlineUtf8(buf), original);
});

Deno.test("tryInlineUtf8: UTF-8 BOM is preserved byte-for-byte", () => {
  const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x61]); // BOM + "a"
  const s = tryInlineUtf8(buf);
  assertEquals(typeof s, "string");
  assertEquals(Buffer.from(s as string, "utf8").equals(buf), true);
});

Deno.test("tryInlineUtf8: empty buffer", () => {
  assertEquals(tryInlineUtf8(Buffer.alloc(0)), "");
});

Deno.test("tryInlineUtf8: invalid UTF-8 bytes return undefined", () => {
  // 0xFF is never a valid UTF-8 start/continuation byte.
  const buf = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
  assertEquals(tryInlineUtf8(buf), undefined);
});

Deno.test("tryInlineUtf8: UTF-8 encoded surrogate returns undefined", () => {
  // ED A0 80 is the UTF-8 encoding of U+D800, which is a reserved surrogate
  // and not valid in well-formed UTF-8.
  const buf = Buffer.from([0xed, 0xa0, 0x80]);
  assertEquals(tryInlineUtf8(buf), undefined);
});

Deno.test("tryInlineUtf8: truncated multi-byte sequence returns undefined", () => {
  // First byte of a 3-byte sequence, but the continuation bytes are missing.
  const buf = Buffer.from([0xe3, 0x81]);
  assertEquals(tryInlineUtf8(buf), undefined);
});

Deno.test("createSymlinkTreeEntry: mode 120000 blob whose content is the target", () => {
  assertEquals(
    createSymlinkTreeEntry({ path: "dir/link.txt", target: "../shared.txt" }),
    {
      path: "dir/link.txt",
      mode: "120000",
      type: "blob",
      content: "../shared.txt",
    },
  );
});

const baseOptions = {
  owner: "owner",
  repo: "repo",
  branch: "branch",
  message: "message",
};

Deno.test("validateOptions: valid symlinks", () => {
  validateOptions({
    ...baseOptions,
    files: ["a.txt"],
    symlinks: [{ path: "link", target: "a.txt" }],
  });
});

Deno.test("validateOptions: empty symlink target throws", () => {
  assertThrows(
    () =>
      validateOptions({
        ...baseOptions,
        symlinks: [{ path: "link", target: "" }],
      }),
    Error,
    "symlink target is required: link",
  );
});

Deno.test("validateOptions: empty symlink path throws", () => {
  assertThrows(
    () =>
      validateOptions({
        ...baseOptions,
        symlinks: [{ path: "", target: "foo" }],
      }),
    Error,
    "symlink path is required",
  );
});

Deno.test("validateOptions: duplicated symlink path throws", () => {
  assertThrows(
    () =>
      validateOptions({
        ...baseOptions,
        symlinks: [
          { path: "link", target: "a" },
          { path: "link", target: "b" },
        ],
      }),
    Error,
    "symlink path is duplicated: link",
  );
});

for (
  const [name, opts] of [
    ["files", { files: ["link"] }],
    ["deletedFiles", { deletedFiles: ["link"] }],
    ["submodules", { submodules: [{ path: "link", sha: "abc" }] }],
  ] as Array<[string, Partial<Options>]>
) {
  Deno.test(`validateOptions: symlink path in ${name} throws`, () => {
    assertThrows(
      () =>
        validateOptions({
          ...baseOptions,
          ...opts,
          symlinks: [{ path: "link", target: "a" }],
        }),
      Error,
      "symlink path must not be passed to files, deletedFiles, or submodules: link",
    );
  });
}

const symlink = (path: string, target = "x") => ({
  path,
  mode: "120000" as const,
  type: "blob" as const,
  content: target,
});
const file = (path: string) => ({
  path,
  mode: "100644" as const,
  type: "blob" as const,
  content: "",
});
const deleted = (path: string) => ({
  path,
  sha: null,
  mode: "100644" as const,
});
const submodule = (path: string) => ({
  path,
  mode: "160000" as const,
  type: "commit" as const,
  sha: "abc",
});
const dir = (path: string) => ({
  path,
  mode: "040000" as const,
  type: "tree" as const,
});

for (
  const [name, tree, message] of [
    [
      "symlink under a symlink",
      [symlink("a"), symlink("a/b")],
      "a/b must not be under the symlink a",
    ],
    [
      "file under a symlink",
      [file("dir/a.txt"), symlink("dir")],
      "dir/a.txt must not be under the symlink dir",
    ],
    [
      "submodule under a symlink",
      [submodule("a/b"), symlink("a")],
      "a/b must not be under the symlink a",
    ],
    [
      "directory under a symlink",
      [dir("a/b"), symlink("a")],
      "a/b must not be under the symlink a",
    ],
    [
      "symlink under a submodule",
      [submodule("a"), symlink("a/b/c")],
      "the symlink a/b/c must not be under a, which isn't a directory",
    ],
    [
      "symlink under a file",
      [file("a"), symlink("a/b")],
      "the symlink a/b must not be under a, which isn't a directory",
    ],
  ] as Array<[string, Parameters<typeof validateTree>[0], string]>
) {
  Deno.test(`validateTree: ${name} throws`, () => {
    assertThrows(() => validateTree(tree), Error, message);
  });
}

for (
  const [name, tree] of [
    ["deletions under a symlink (a directory is replaced with a symlink)", [
      deleted("dir/a.txt"),
      deleted("dir/b/c.txt"),
      symlink("dir"),
    ]],
    ["symlink under a directory", [dir("a"), symlink("a/b")]],
    ["symlink under a deleted file (a file is replaced with a directory)", [
      deleted("a"),
      symlink("a/b"),
    ]],
    ["sibling paths sharing a prefix", [
      submodule("ab"),
      file("ab-c/d"),
      symlink("a"),
      symlink("a-b"),
    ]],
    ["no symlinks (not checked)", [submodule("a"), file("a/b")]],
  ] as Array<[string, Parameters<typeof validateTree>[0]]>
) {
  Deno.test(`validateTree: ${name} is allowed`, () => {
    validateTree(tree);
  });
}

Deno.test("removeDeletionsUnderSymlinks: deletions under a symlink are removed", () => {
  assertEquals(
    removeDeletionsUnderSymlinks([
      deleted("dir/a.txt"),
      deleted("dir/b/c.txt"),
      deleted("dir-2/a.txt"),
      deleted("other.txt"),
      file("x.txt"),
      symlink("dir"),
    ]),
    [
      deleted("dir-2/a.txt"),
      deleted("other.txt"),
      file("x.txt"),
      symlink("dir"),
    ],
  );
});

Deno.test("removeDeletionsUnderSymlinks: no symlinks", () => {
  const tree = [deleted("dir/a.txt"), file("x.txt")];
  assertEquals(removeDeletionsUnderSymlinks(tree), tree);
});

Deno.test("createCommit: replace a directory with a symlink", async () => {
  const { octokit, calls } = fakeOctokit();
  await createCommit(octokit, {
    ...baseOptions,
    deletedFiles: ["dir/a.txt"],
    symlinks: [{ path: "dir", target: "other" }],
    logger: { info: () => {} },
  });
  assertEquals(calls.tree, [symlink("dir", "other")]);
});

Deno.test("listParentDirs: parents of added paths except deleted paths", () => {
  assertEquals(
    listParentDirs([
      symlink("a/b/link"),
      file("c/d.txt"),
      deleted("e/f.txt"),
      deleted("c"),
      submodule("g/sub"),
      file("top.txt"),
      dir("h"),
      file("h/i.txt"),
    ]).sort(),
    ["a", "a/b", "g"],
  );
});

Deno.test("pickReplacedParents: files and symlinks in the base tree", () => {
  const typenames = new Map<string, string | null>([
    ["f", "Blob"],
    ["dir", "Tree"],
    ["dir/link", "Blob"],
    ["new", null],
  ]);
  assertEquals(pickReplacedParents(typenames), ["f", "dir/link"]);
  assertThrows(
    () => pickReplacedParents(new Map([["sub", "Commit"]])),
    Error,
    "sub is a submodule in the base tree",
  );
});

Deno.test("replaceParents: deletions first, without deletions under them", () => {
  assertEquals(
    replaceParents(
      [
        deleted("f/old"),
        deleted("f/g/old"),
        deleted("f-2/old"),
        symlink("f/new"),
        file("x.txt"),
      ],
      ["f"],
    ),
    [deleted("f"), deleted("f-2/old"), symlink("f/new"), file("x.txt")],
  );
});

// fakeOctokit records the tree passed to createTree.
// baseTypes maps a path in the base tree to the GraphQL typename of the
// object (Blob, Tree, or Commit). Like the real API, createTree fails with
// GitRPC::BadObjectState if a path is added under a Blob or a Commit which
// isn't deleted.
const fakeOctokit = (baseTypes: Record<string, string> = {}) => {
  const calls: { tree?: unknown[]; createTree: number; treeQueries: number } = {
    createTree: 0,
    treeQueries: 0,
  };
  const octokit = {
    graphql: (query: string, variables: Record<string, string>) => {
      if (query.includes("ref(qualifiedName")) {
        return Promise.resolve({
          repository: {
            ref: {
              target: { oid: "base-commit", tree: { oid: "base-tree" } },
            },
          },
        });
      }
      calls.treeQueries++;
      const repository: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(variables)) {
        if (!/^p\d+$/.test(key)) {
          continue;
        }
        const typename = baseTypes[value.replace(/^base-tree:/, "")];
        repository[key] = typename ? { __typename: typename } : null;
      }
      return Promise.resolve({ repository });
    },
    rest: {
      git: {
        createTree: (
          params: { tree: { path: string; sha?: string | null }[] },
        ) => {
          calls.createTree++;
          const deleted = new Set(
            params.tree.filter((e) => e.sha === null).map((e) => e.path),
          );
          for (const entry of params.tree) {
            if (entry.sha === null) {
              // Deleting a path under a Blob, which doesn't exist, fails
              const elems = entry.path.split("/");
              for (let i = 1; i < elems.length; i++) {
                if (baseTypes[elems.slice(0, i).join("/")] === "Blob") {
                  return Promise.reject(new Error("GitRPC::BadObjectState"));
                }
              }
              continue;
            }
            const elems = entry.path.split("/");
            for (let i = 1; i < elems.length; i++) {
              const parent = elems.slice(0, i).join("/");
              if (
                ["Blob", "Commit"].includes(baseTypes[parent]) &&
                !deleted.has(parent)
              ) {
                return Promise.reject(new Error("GitRPC::BadObjectState"));
              }
            }
          }
          calls.tree = params.tree;
          return Promise.resolve({ data: { sha: "new-tree" } });
        },
        createCommit: () => Promise.resolve({ data: { sha: "new-commit" } }),
        updateRef: () =>
          Promise.resolve({ data: { object: { sha: "new-commit" } } }),
      },
    },
  };
  return { octokit: octokit as unknown as GitHub, calls };
};

Deno.test("createCommit: only symlinks", async () => {
  const { octokit, calls } = fakeOctokit();
  const result = await createCommit(octokit, {
    ...baseOptions,
    symlinks: [{ path: "dir/link.txt", target: "../shared.txt" }],
    logger: { info: () => {} },
  });
  assertEquals(result, { commit: { sha: "new-commit" } });
  assertEquals(calls.tree, [
    {
      path: "dir/link.txt",
      mode: "120000",
      type: "blob",
      content: "../shared.txt",
    },
  ]);
});

Deno.test("createCommit: only submodules", async () => {
  const { octokit, calls } = fakeOctokit();
  const result = await createCommit(octokit, {
    ...baseOptions,
    submodules: [{ path: "sub", sha: "abc" }],
    logger: { info: () => {} },
  });
  assertEquals(result, { commit: { sha: "new-commit" } });
  assertEquals(calls.tree, [
    { path: "sub", mode: "160000", type: "commit", sha: "abc" },
  ]);
});

Deno.test("createCommit: nothing to commit", async () => {
  const { octokit, calls } = fakeOctokit();
  assertEquals(await createCommit(octokit, baseOptions), undefined);
  assertEquals(calls.tree, undefined);
});

Deno.test("createCommit: delete a file in the base tree replaced with a directory", async () => {
  const { octokit, calls } = fakeOctokit({
    f: "Blob",
    dir: "Tree",
    "dir/link": "Blob",
  });
  await createCommit(octokit, {
    ...baseOptions,
    symlinks: [
      { path: "f/a", target: "x" },
      { path: "dir/link/b", target: "y" },
      { path: "dir/c", target: "z" },
    ],
    logger: { info: () => {} },
  });
  // Deletions are put first
  assertEquals(calls.tree, [
    deleted("f"),
    deleted("dir/link"),
    symlink("f/a", "x"),
    symlink("dir/link/b", "y"),
    symlink("dir/c", "z"),
  ]);
  assertEquals(calls.createTree, 2);
});

Deno.test("createCommit: an already deleted parent isn't queried", async () => {
  const { octokit, calls } = fakeOctokit({ f: "Blob" });
  await createCommit(octokit, {
    ...baseOptions,
    deletedFiles: ["f"],
    symlinks: [{ path: "f/a", target: "x" }],
    logger: { info: () => {} },
  });
  assertEquals(calls.tree, [deleted("f"), symlink("f/a", "x")]);
  assertEquals(calls.treeQueries, 0);
});

Deno.test("createCommit: a path under a submodule in the base tree throws", async () => {
  const { octokit } = fakeOctokit({ sub: "Commit" });
  await assertRejects(
    () =>
      createCommit(octokit, {
        ...baseOptions,
        symlinks: [{ path: "sub/a", target: "x" }],
        logger: { info: () => {} },
      }),
    Error,
    "sub is a submodule in the base tree",
  );
});

Deno.test("createCommit: the base tree isn't queried if createTree succeeds", async () => {
  const { octokit, calls } = fakeOctokit({ dir: "Tree" });
  await createCommit(octokit, {
    ...baseOptions,
    symlinks: [{ path: "dir/link", target: "x" }],
    logger: { info: () => {} },
  });
  assertEquals(calls.treeQueries, 0);
  assertEquals(calls.createTree, 1);
});

Deno.test("createCommit: BadObjectState for another reason is thrown as is", async () => {
  const { octokit, calls } = fakeOctokit({ f: "Blob" });
  // Simulate BadObjectState for another reason: createTree fails, but the
  // query finds no file or symlink in the parents.
  (octokit as unknown as { graphql: unknown }).graphql = (query: string) =>
    query.includes("ref(qualifiedName")
      ? Promise.resolve({
        repository: {
          ref: { target: { oid: "base-commit", tree: { oid: "base-tree" } } },
        },
      })
      : Promise.resolve({ repository: {} });
  await assertRejects(
    () =>
      createCommit(octokit, {
        ...baseOptions,
        symlinks: [{ path: "f/a", target: "x" }],
        logger: { info: () => {} },
      }),
    Error,
    "GitRPC::BadObjectState",
  );
  assertEquals(calls.createTree, 1);
});

Deno.test("createCommit: the base tree isn't queried with noParent", async () => {
  const { octokit, calls } = fakeOctokit();
  await createCommit(octokit, {
    ...baseOptions,
    noParent: true,
    symlinks: [{ path: "f/a", target: "x" }],
    logger: { info: () => {} },
  });
  assertEquals(calls.treeQueries, 0);
  assertEquals(calls.tree, [symlink("f/a", "x")]);
});

Deno.test("createCommit: deletions under a replaced parent are removed", async () => {
  const { octokit, calls } = fakeOctokit({ f: "Blob" });
  await createCommit(octokit, {
    ...baseOptions,
    deletedFiles: ["f/old"],
    symlinks: [{ path: "f/new", target: "x" }],
    logger: { info: () => {} },
  });
  assertEquals(calls.tree, [deleted("f"), symlink("f/new", "x")]);
});

Deno.test("createCommit: the original error is thrown if the query fails", async () => {
  const { octokit } = fakeOctokit({ f: "Blob" });
  (octokit as unknown as { graphql: unknown }).graphql = (query: string) =>
    query.includes("ref(qualifiedName")
      ? Promise.resolve({
        repository: {
          ref: { target: { oid: "base-commit", tree: { oid: "base-tree" } } },
        },
      })
      : Promise.reject(new Error("rate limit"));
  await assertRejects(
    () =>
      createCommit(octokit, {
        ...baseOptions,
        symlinks: [{ path: "f/a", target: "x" }],
        logger: { info: () => {} },
      }),
    Error,
    "GitRPC::BadObjectState",
  );
});
