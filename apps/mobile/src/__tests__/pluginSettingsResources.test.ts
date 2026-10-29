import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  removed: [] as string[],
}));
const native = vi.hoisted(() => ({
  start: vi.fn(
    async (
      _root: string,
      _entry: string,
      _token: string,
      _csp: string,
      _files: string[][],
    ) => "http://127.0.0.1:42300/__cindy/test",
  ),
  stop: vi.fn(async (_token: string) => {}),
}));
vi.mock("../../modules/cindy-html-preview/src/CindyHtmlPreviewModule", () => ({
  default: native,
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(2),
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
      state.removed.push(this.uri);
    }
  },
  File: class {
    name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
    }
    create() {}
    write(value: string | Uint8Array) {
      state.files.set(this.name, value);
    }
  },
}));
import { preparePluginSettingsResources } from "../plugins/pluginSettingsResources";
import type { PluginSettingsClient } from "../plugins/pluginSettingsClient";

/* 测试价值
 * 生产入口与可观察结果：preparePluginSettingsResources发布完整原包到既有服务器，失败/取消清掉自己的缓存。
 * Bug／规则依据：credentials-and-local-storage「临时文件」；plugin-mobile-implementation「页面租约」。
 * 现有覆盖缺口：pluginLocalPreview测按需远程URL，未覆盖settings包清单、桥先执行及start期间取消。
 * 最小失败输入：UI子目录+相对模块/CSS、读取失败、服务器创建尚未完成时离页、重复close。
 * tier：unit；原生边界和文件系统用内存fake，不运行真实App或读取用户数据。
 * 实测耗时：单文件墙钟 1.06s。
 */
beforeEach(() => {
  vi.clearAllMocks();
  state.files.clear();
  state.removed.length = 0;
});
function fixture() {
  const content = new Map([
    [
      "ui/settings.html",
      '<html><head><link rel="stylesheet" href="./style.css"><script type="module" src="./main.js"></script></head><body>Original</body></html>',
    ],
    ["ui/main.js", 'import "./child.js"; fetch("cindy-ghost://test/kv");'],
    ["ui/child.js", 'export const label = "original";'],
    ["ui/style.css", 'body { background-image: url("./icon.svg"); }'],
    ["ui/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ]);
  const document = {
    pageId: "settings",
    pluginId: "test",
    manifestId: "test",
    name: "Original",
    entry: "ui/settings.html",
    files: [...content].map(([path, text]) => ({
      path,
      size: Buffer.byteLength(text),
      mime: path.endsWith("html")
        ? "text/html; charset=utf-8"
        : path.endsWith("css")
          ? "text/css; charset=utf-8"
          : path.endsWith("svg")
            ? "image/svg+xml"
            : "text/javascript; charset=utf-8",
    })),
  };
  const send = vi.fn(async (command: any) => ({
    base64: Buffer.from(content.get(command.path)!).toString("base64"),
    mime: document.files.find((file) => file.path === command.path)!.mime,
  }));
  return {
    client: {
      document,
      send,
      assertCurrent: () => {},
    } as unknown as PluginSettingsClient,
    send,
  };
}
const theme = { dark: false, colors: { "panel-bg": "ivory" } };
describe("dedicated settings resource origin", () => {
  it("publishes relative modules/CSS intact and only writes package bytes plus a public bridge", async () => {
    const f = fixture(),
      resource = await preparePluginSettingsResources(
        f.client,
        theme,
        new AbortController().signal,
      );
    const [, entry, token, csp, files] = native.start.mock.calls[0];
    expect(entry).toBe("ui/settings.html");
    expect(csp).toContain("form-action 'none'");
    expect(files.map((file) => file[0])).toContain("ui/child.js");
    // The installed native server accepts a bare media type, while chunks retain Host MIME.
    expect(files.find((file) => file[0] === "ui/settings.html")?.[2]).toBe(
      "text/html",
    );
    expect(files.find((file) => file[0] === "ui/main.js")?.[2]).toBe(
      "text/javascript",
    );
    expect(state.files.get("0")).toContain(
      '<head><script src="/__cindy_settings_bridge.js"></script>',
    );
    expect(state.files.get("0")).toContain('href="./style.css"');
    expect(state.files.get("1")).toContain('import "./child.js"; fetch("/kv")');
    expect(state.files.get("3")).toBe(
      'body { background-image: url("./icon.svg"); }',
    );
    expect(
      f.send.mock.calls.every(([command]) => command.kind === "asset"),
    ).toBe(true);
    await resource.close();
    await resource.close();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.stop).toHaveBeenCalledWith(token);
    expect(state.removed).toEqual([`file:///cache/html-previews/${token}`]);
  });
  it("does not start a partial page and deletes its cache when package reading fails", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("SOURCE_CHANGED"));
    await expect(
      preparePluginSettingsResources(
        f.client,
        theme,
        new AbortController().signal,
      ),
    ).rejects.toThrow("SOURCE_CHANGED");
    expect(native.start).not.toHaveBeenCalled();
    expect(state.removed).toHaveLength(1);
  });
  it("stops a server created after cancellation, then removes its directory", async () => {
    const f = fixture(),
      abort = new AbortController();
    let finish!: (url: string) => void;
    native.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = preparePluginSettingsResources(f.client, theme, abort.signal);
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
    abort.abort();
    expect(native.stop).not.toHaveBeenCalled();
    finish("http://127.0.0.1:42300/__cindy/test");
    await expect(work).rejects.toThrow("CLOSED");
    expect(native.stop).toHaveBeenCalledOnce();
    expect(state.removed).toHaveLength(1);
  });
  it("does not materialize anything for an already cancelled lease", async () => {
    const f = fixture(),
      abort = new AbortController();
    abort.abort();
    await expect(
      preparePluginSettingsResources(f.client, theme, abort.signal),
    ).rejects.toThrow("CLOSED");
    expect(f.send).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
  });
});

// Regression: each package file used to wait a full remote round trip. A deferred
// transport verifies bounded overlapping reads and rejects late bytes after cancellation.
it.each([false, true])("overlaps independent assets without publishing partial or cancelled files (abort=%s)", async (cancel) => {
  const f = fixture(), abort = new AbortController();
  const original = f.send.getMockImplementation()!;
  const finishes: Array<() => void> = [];
  f.send.mockImplementation((command) => new Promise((resolve) => {
    finishes.push(() => { void original(command).then(resolve); });
  }));
  const work = preparePluginSettingsResources(f.client, theme, abort.signal);
  const outcome = work.then((resource) => resource, (error: Error) => error);
  await Promise.resolve();
  const initialRequests = finishes.length;
  if (cancel) abort.abort();
  // Settle every outstanding request even if an assertion below fails.
  while (finishes.length) {
    finishes.splice(0).reverse().forEach((finish) => finish());
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  const result = await outcome;
  expect(initialRequests).toBe(4);
  if (cancel) {
    expect(result).toBeInstanceOf(Error);
    expect(native.start).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
  } else {
    expect(result).not.toBeInstanceOf(Error);
    expect(native.start.mock.calls[0][4].slice(0, 5).map((file) => file[1])).toEqual(["0", "1", "2", "3", "4"]);
    await (result as { close(): Promise<void> }).close();
  }
});
