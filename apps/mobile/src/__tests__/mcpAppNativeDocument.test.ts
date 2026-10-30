import { beforeEach, expect, it, vi } from "vitest";
import { Script } from 'node:vm';

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  removed: [] as string[],
  start: vi.fn(),
  stop: vi.fn(),
  random: 0,
  hostAvailable: true,
  startAvailable: true,
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (size: number) => new Uint8Array(size).fill(++state.random),
}));
vi.mock("../../modules/cindy-html-preview/src/CindyHtmlPreviewModule", () => ({
  default: {
    get appHostAvailable() { return state.hostAvailable; },
    get startApp() { return state.startAvailable ? state.start : undefined; },
    stop: state.stop,
  },
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    get exists() {
      return this.uri.endsWith("/mcp-apps") ? false : true;
    }
    create() {}
    delete() {
      state.removed.push(this.uri);
    }
  }
  class File extends Directory {
    write(value: string) {
      state.files.set(this.uri, value);
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});
import { MCP_APP_STORAGE_BOOTSTRAP, prepareMcpAppNativeDocument } from "../session/mcpAppNativeDocument";

const document = {
  viewId: "view",
  html: "<script>window.app=true</script>",
  csp: "default-src 'none'; script-src 'unsafe-inline'",
  prefersBorder: true,
};
beforeEach(() => {
  state.files.clear();
  state.removed = [];
  state.random = 0;
  state.hostAvailable = true;
  state.startAvailable = true;
  state.start
    .mockReset()
    .mockImplementation(
      async (_root, _entry, token) =>
        `http://127.0.0.1:${5000 + state.start.mock.calls.length}/__cindy/${token}`,
    );
  state.stop.mockReset().mockResolvedValue(undefined);
});
it.each(['host', 'server'])('requires a compatible native %s before writing private files', async (missing) => {
  if (missing === 'host') state.hostAvailable = false;
  else state.startAvailable = false;
  await expect(prepareMcpAppNativeDocument(document, 'native-key'))
    .rejects.toThrow('MCP_APP_NATIVE_UPDATE_REQUIRED');
  expect(state.files.size).toBe(0);
  expect(state.start).not.toHaveBeenCalled();
  expect(state.stop).not.toHaveBeenCalled();
});
it("serves complete App HTML and its exact CSP on a different origin from the trusted proxy", async () => {
  const view = await prepareMcpAppNativeDocument(document, "native-key");
  expect(new URL(view.source.uri).origin).not.toBe(
    new URL(view.resourceUrl).origin,
  );
  const [resource, proxy] = state.start.mock.calls;
  expect(resource[3]).toBe(document.csp);
  expect(resource[1]).toBe('initialize.html');
  expect(resource[4]).toEqual([["initialize.html", "2", "text/html"], ["resource.html", "0", "text/html"]]);
  expect(
    state.files.get("file:///cache/mcp-apps/" + "01".repeat(24) + "/0"),
  ).toBe(document.html);
  expect(proxy[4]).toEqual([["proxy.html", "1", "text/html"]]);
  expect(proxy[3]).toContain("frame-src " + new URL(view.resourceUrl).origin);
  expect(proxy[3]).toContain("connect-src 'none'");
  const html = state.files.get(
    "file:///cache/mcp-apps/" + "01".repeat(24) + "/1",
  )!;
  expect(html).toContain(
    "const expectedResourceUrl=" + JSON.stringify(view.resourceUrl),
  );
  expect(view.documentUrls).toEqual([
    view.source.uri,
    "http://127.0.0.1:5002/proxy.html",
    view.resourceUrl,
    "http://127.0.0.1:5001/initialize.html",
    "http://127.0.0.1:5001/resource.html",
  ]);
  await Promise.all([view.close(), view.close()]);
  expect(state.stop.mock.calls.map(([token]) => token)).toEqual([
    "01".repeat(24),
    "02".repeat(24),
  ]);
  expect(state.removed).toHaveLength(1);
});
it('clears DOM storage and waits for IndexedDB deletion before loading untrusted HTML', async () => {
  const localStorage = { clear: vi.fn() };
  const sessionStorage = { clear: vi.fn() };
  const pending: Array<{ onsuccess?: () => void; onerror?: () => void; onblocked?: () => void }> = [];
  const replace = vi.fn();
  const indexedDB = { databases: async () => [{ name: 'old-app' }, { name: 'other-db' }],
    deleteDatabase: vi.fn(() => { const request = {}; pending.push(request); return request; }) };
  const script = MCP_APP_STORAGE_BOOTSTRAP.split('<script>')[1].split('</script>')[0];
  const result = new Script(script).runInNewContext({ localStorage, sessionStorage, indexedDB, location: { replace } });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(localStorage.clear).toHaveBeenCalledOnce();
  expect(sessionStorage.clear).toHaveBeenCalledOnce();
  expect(indexedDB.deleteDatabase.mock.calls).toEqual([['old-app'], ['other-db']]);
  expect(replace).not.toHaveBeenCalled();
  pending[0].onsuccess!();
  await Promise.resolve();
  expect(replace).not.toHaveBeenCalled();
  pending[1].onsuccess!();
  await result;
  expect(replace).toHaveBeenCalledWith('/resource.html');
});
it.each(['onerror', 'onblocked'])('does not load an App when storage deletion signals %s', async (event) => {
  const request: Record<string, () => void> = {};
  const replace = vi.fn();
  const script = MCP_APP_STORAGE_BOOTSTRAP.split('<script>')[1].split('</script>')[0];
  const result = new Script(script).runInNewContext({ localStorage: { clear() {} }, sessionStorage: { clear() {} },
    indexedDB: { databases: async () => [{ name: 'old-app' }], deleteDatabase: () => request }, location: { replace } });
  await vi.waitFor(() => expect(request[event]).toBeTypeOf('function'));
  request[event]();
  await result;
  expect(replace).not.toHaveBeenCalled();
});
it.each([1, 2])(
  "reclaims every attempted server and the private cache when start %s fails",
  async (failed) => {
    state.start.mockImplementation(async (_root, _entry, token) => {
      if (state.start.mock.calls.length === failed)
        throw new Error("START_FAILED");
      return `http://127.0.0.1:5001/__cindy/${token}`;
    });
    await expect(
      prepareMcpAppNativeDocument(document, "native-key"),
    ).rejects.toThrow("START_FAILED");
    expect(state.stop).toHaveBeenCalledTimes(failed);
    expect(state.removed).toHaveLength(1);
  },
);
it("rejects a native response that would place App and proxy on one origin", async () => {
  state.start.mockResolvedValue("http://127.0.0.1:5001/document");
  await expect(
    prepareMcpAppNativeDocument(document, "native-key"),
  ).rejects.toThrow("MCP_APP_INVALID_ORIGIN");
  expect(state.stop).toHaveBeenCalledTimes(2);
  expect(state.removed).toHaveLength(1);
});
it("waits for every server to stop before removing its files, even when one stop fails", async () => {
  const view = await prepareMcpAppNativeDocument(document, "native-key");
  let finish!: () => void;
  state.stop
    .mockRejectedValueOnce(new Error("STOP_FAILED"))
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  const closing = view.close();
  const result = expect(closing).rejects.toThrow("STOP_FAILED");
  await Promise.resolve();
  expect(state.removed).toHaveLength(0);
  finish();
  await result;
  expect(state.removed).toHaveLength(1);
});
