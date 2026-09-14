import { beforeEach, describe, expect, it, vi } from "vitest";
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  closed: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get name() {
      return this.uri.split("/").at(-1)!;
    }
    get exists() {
      return disk.files.has(this.uri);
    }
    get size() {
      return new TextEncoder().encode(disk.files.get(this.uri) ?? "").length;
    }
    create() {
      if (this.exists) throw new Error("exists");
      disk.files.set(this.uri, "");
    }
    write(value: string | Uint8Array, options?: { append: boolean }) {
      const text =
        typeof value === "string" ? value : new TextDecoder().decode(value);
      disk.files.set(
        this.uri,
        (options?.append ? (disk.files.get(this.uri) ?? "") : "") + text,
      );
    }
    delete() {
      disk.files.delete(this.uri);
    }
    open() {
      const bytes = new TextEncoder().encode(disk.files.get(this.uri)!);
      return {
        offset: 0,
        size: bytes.length,
        close: disk.closed,
        readBytes(length: number) {
          const chunk = bytes.slice(this.offset, this.offset + length);
          this.offset += chunk.length;
          return chunk;
        },
      };
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return disk.dirs.has(this.uri);
    }
    create() {
      disk.dirs.add(this.uri);
    }
    list() {
      return [...disk.files.keys()]
        .filter((path) => path.startsWith(this.uri + "/"))
        .map((path) => new File(path));
    }
  }
  return {
    File,
    Directory,
    Paths: { document: "file:///documents", cache: "file:///cache" },
  };
});
import { File } from "expo-file-system";
import {
  appendMobileDebugFile,
  clearMobileDebugFiles,
  copyMobileDebugFiles,
  pruneMobileDebugFiles,
  DEBUG_FILE_BYTES,
} from "./mobileDebugFiles";

beforeEach(() => {
  disk.files.clear();
  disk.dirs.clear();
  disk.closed.mockClear();
});
describe("bounded debug files readable from the app container", () => {
  it("does not create storage when pruning a never-enabled journal", () => {
    pruneMobileDebugFiles();
    expect(disk.dirs.size).toBe(0);
    expect(disk.files.size).toBe(0);
  });
  it("appends valid detailed lines and exports all chunks, closing input handles", () => {
    appendMobileDebugFile('{"level":"debug"}\n');
    appendMobileDebugFile('{"level":"error"}\n');
    expect(disk.files.size).toBe(1);
    expect([...disk.files.keys()][0]).toMatch(
      /documents\/cindy-debug\/mobile-debug-.*\.ndjson/,
    );
    const out = new File("file:///cache/export.ndjson");
    copyMobileDebugFiles(out);
    expect(disk.files.get(out.uri)).toBe(
      '{"level":"debug"}\n{"level":"error"}\n',
    );
    expect(disk.closed).toHaveBeenCalledOnce();
  });
  it("rotates at byte boundaries and retains at most eight files", () => {
    for (let i = 0; i < 12; i++)
      appendMobileDebugFile(String(i % 10).repeat(DEBUG_FILE_BYTES));
    expect(disk.files.size).toBe(8);
    expect(
      [...disk.files.values()].every(
        (value) => value.length <= DEBUG_FILE_BYTES,
      ),
    ).toBe(true);
    expect(() => appendMobileDebugFile("中".repeat(DEBUG_FILE_BYTES))).toThrow(
      "too large",
    );
  });
  it("prunes expired files, preserves unrelated files and clears only its owned logs", () => {
    appendMobileDebugFile("recent\n");
    const old = `file:///documents/cindy-debug/mobile-debug-${Date.now() - 8 * 86400_000}-0.ndjson`;
    disk.files.set(old, "expired\n");
    disk.files.set("file:///documents/cindy-debug/unrelated.txt", "keep");
    pruneMobileDebugFiles();
    expect(disk.files.has(old)).toBe(false);
    expect([...disk.files.values()]).toContain("recent\n");
    clearMobileDebugFiles();
    expect([...disk.files.entries()]).toEqual([
      ["file:///documents/cindy-debug/unrelated.txt", "keep"],
    ]);
  });
});
