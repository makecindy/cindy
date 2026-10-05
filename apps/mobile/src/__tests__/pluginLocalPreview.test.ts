import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  listener: undefined as
    ((event: { token: string; id: string; path: string }) => void) | undefined,
  startOnDemand: vi.fn(async (_root: string, _entry: string, _token: string, _csp: string) => "http://127.0.0.1:8080/__cindy/preview"),
  resolveRequest: vi.fn(
    async (_token: string, _id: string, _path: string | null) => true,
  ),
  stop: vi.fn(async () => {}),
  addListener: vi.fn((_, listener) => {
    native.listener = listener;
    return { remove: vi.fn() };
  }),
}));
const disk = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  removed: [] as string[],
}));
vi.mock("../../modules/cindy-html-preview/src/CindyHtmlPreviewModule", () => ({
  default: native,
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (size: number) => new Uint8Array(size).fill(1),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    uri: string;
    exists = false;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    create() {
      this.exists = true;
    }
    delete() {
      this.exists = false;
      disk.removed.push(this.uri);
    }
  },
  File: class {
    name: string;
    exists = false;
    constructor(_: unknown, name: string) {
      this.name = name;
    }
    create() {
      this.exists = true;
    }
    write(value: string | Uint8Array) {
      disk.files.set(this.name, value);
    }
    delete() {
      this.exists = false;
      disk.files.delete(this.name);
    }
  },
}));
import { preparePluginLocalPreview } from "../plugins/pluginLocalPreview";
describe("computer preview on the existing native resource viewer", () => {
  it("binds resources to the source computer, reconstructs chunks and cleans only its own temporary directory", async () => {
    native.resolveRequest.mockClear();
    disk.files.clear();
    disk.removed.length = 0;
    const source = "http://localhost:1234/course/?topic=music",
      content =
        '<html><script src="http://localhost:1234/course/app.js"></script><p>' +
        "a".repeat(60000) +
        "</p></html>";
    const bytes = Buffer.from(content),
      controller = new AbortController();
    const read = vi.fn(async (_url: string, offset: number) => ({
      status: 200,
      mime: "text/html",
      revision: "revision",
      base64: bytes.subarray(offset, offset + 49152).toString("base64"),
      ...(offset + 49152 < bytes.length ? { nextOffset: offset + 49152 } : {}),
    }));
    const preview = await preparePluginLocalPreview(
      source,
      read,
      controller.signal,
    );
    const token = native.startOnDemand.mock.calls[0][2] as string;
    native.listener!({
      token: "another-preview",
      id: "foreign",
      path: "secret",
    });
    expect(read).not.toHaveBeenCalled();
    native.listener!({ token, id: "entry", path: "course/index.html" });
    await vi.waitFor(() =>
      expect(native.resolveRequest).toHaveBeenCalledWith(
        token,
        "entry",
        "0",
        "text/html",
        200,
      ),
    );
    expect(read.mock.calls[0]).toEqual([source, 0, undefined]);
    expect(read.mock.calls[1]).toEqual([source, 49152, "revision"]);
    const html = disk.files.get("0") as string;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("http://127.0.0.1:8080/course/app.js");
    expect(html).toContain("__cindy_plugin_query");
    await preview.close();
    expect(native.stop).toHaveBeenCalledWith(token);
    expect(disk.removed).toEqual([`file:///cache/html-previews/${token}`]);
  });
});
