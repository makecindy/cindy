import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_CHUNK_CHARS,
  parseClipboardContentRequest,
} from "../remoteClipboard";

describe("inline clipboard request validation", () => {
  const paste = {
    action: "paste",
    sync: true,
    version: "1",
    data: '{"text":"hello"}',
  };
  it("requires a version-bound sync write with a bounded portable payload", () => {
    expect(parseClipboardContentRequest(paste, "lease")).toMatchObject(paste);
    for (const change of [
      { sync: false },
      { version: undefined },
      { data: "bad" },
      { data: '{"path":"/tmp/file"}' },
      { data: "x".repeat(CLIPBOARD_CHUNK_CHARS + 1) },
    ])
      expect(() =>
        parseClipboardContentRequest({ ...paste, ...change }, "lease"),
      ).toThrow();
  });
  it("keeps legacy copy requests unchanged and validates inline opt-in", () => {
    expect(parseClipboardContentRequest({ action: "copy" }, "lease")).toEqual({
      op: "clipboardContent",
      lease: "lease",
      action: "copy",
    });
    expect(() =>
      parseClipboardContentRequest({ action: "copy", inline: true }, "lease"),
    ).toThrow();
    expect(
      parseClipboardContentRequest(
        { action: "copy", inline: true, sync: true, version: "1" },
        "lease",
      ),
    ).toMatchObject({ inline: true, sync: true, version: "1" });
  });
});
