import { assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { shouldCreateRef, tryInlineUtf8 } from "./main.ts";

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

Deno.test("shouldCreateRef: 422 Reference does not exist (PAT)", () => {
  const err = Object.assign(new Error("Reference does not exist"), {
    status: 422,
  });
  assertEquals(shouldCreateRef(err), true);
});

Deno.test("shouldCreateRef: 403 Resource not accessible by integration (GitHub App)", () => {
  // Updating a non-existent ref with a GitHub App installation token returns 403,
  // not the 422 message, so the branch must still be created.
  const err = Object.assign(
    new Error("Resource not accessible by integration"),
    { status: 403 },
  );
  assertEquals(shouldCreateRef(err), true);
});

Deno.test("shouldCreateRef: 404 Not Found", () => {
  const err = Object.assign(new Error("Not Found"), { status: 404 });
  assertEquals(shouldCreateRef(err), true);
});

Deno.test("shouldCreateRef: unrelated failure is rethrown", () => {
  const err = Object.assign(new Error("Validation Failed"), { status: 422 });
  assertEquals(shouldCreateRef(err), false);
});

Deno.test("shouldCreateRef: non-Error value", () => {
  assertEquals(shouldCreateRef("boom"), false);
  assertEquals(shouldCreateRef(null), false);
});
