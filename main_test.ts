import { assertEquals, assertThrows } from "@std/assert";
import { Buffer } from "node:buffer";
import {
  createCommit,
  createSymlinkTreeEntry,
  type GitHub,
  type Options,
  tryInlineUtf8,
  validateOptions,
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

for (
  const [name, opts] of [
    ["symlink under a symlink", {
      symlinks: [{ path: "a", target: "x" }, { path: "a/b", target: "y" }],
    }],
    ["symlink under a submodule", {
      submodules: [{ path: "a", sha: "abc" }],
      symlinks: [{ path: "a/b/c", target: "y" }],
    }],
    ["submodule under a symlink", {
      submodules: [{ path: "a/b", sha: "abc" }],
      symlinks: [{ path: "a", target: "x" }],
    }],
  ] as Array<[string, Partial<Options>]>
) {
  Deno.test(`validateOptions: ${name} throws`, () => {
    assertThrows(
      () => validateOptions({ ...baseOptions, ...opts }),
      Error,
      "because a symlink and a submodule can't contain other paths",
    );
  });
}

Deno.test("validateOptions: files and deletedFiles under a symlink are allowed", () => {
  // e.g. a directory is replaced with a symlink
  validateOptions({
    ...baseOptions,
    files: ["dir/a.txt"],
    deletedFiles: ["dir/b.txt"],
    symlinks: [{ path: "dir", target: "other" }],
  });
});

Deno.test("validateOptions: sibling paths sharing a prefix are allowed", () => {
  validateOptions({
    ...baseOptions,
    submodules: [{ path: "ab", sha: "abc" }],
    symlinks: [{ path: "a", target: "x" }, { path: "a-b", target: "y" }],
  });
});

// fakeOctokit records the tree passed to createTree.
const fakeOctokit = () => {
  const calls: { tree?: unknown[] } = {};
  const octokit = {
    graphql: () =>
      Promise.resolve({
        repository: {
          ref: { target: { oid: "base-commit", tree: { oid: "base-tree" } } },
        },
      }),
    rest: {
      git: {
        createTree: (params: { tree: unknown[] }) => {
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
