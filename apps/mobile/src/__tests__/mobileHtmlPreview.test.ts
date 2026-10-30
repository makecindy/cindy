import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contents: new Map<string, Uint8Array>(),
  removed: [] as string[],
  released: [] as string[],
  remote: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  download: vi.fn(),
  pause: vi.fn(),
  cache: vi.fn(),
  sequence: 0,
  demand: false,
  startOnDemand: vi.fn(),
  resolveRequest: vi.fn(),
  listeners: new Map<string, (event: { token: string; id: string; path?: string }) => void>(),
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: () => new Uint8Array(24).fill(++mocks.sequence),
}));
vi.mock("@/session/mobileHtmlPreviewCache", () => ({ createMobileHtmlPreviewCache: mocks.cache }));
vi.mock("../../modules/cindy-html-preview/src/CindyHtmlPreviewModule", () => ({
  default: {
    start: mocks.start, stop: mocks.stop,
    get startOnDemand() { return mocks.demand ? mocks.startOnDemand : undefined; },
    get resolveRequest() { return mocks.demand ? mocks.resolveRequest : undefined; },
    addListener: (event: string, listener: (event: { token: string; id: string; path?: string }) => void) => {
      mocks.listeners.set(event, listener);
      return { remove: () => { if (mocks.listeners.get(event) === listener) mocks.listeners.delete(event); } };
    },
  },
}));
vi.mock("@/session/remoteAbsFileFetch", () => ({
  fetchRemoteAbsFileOnce: mocks.remote,
}));
vi.mock("@/device-link/remoteRetry", () => ({
  withTransientRemoteRetry: (operation: () => unknown) => operation(),
}));
// Releasing a direct-transfer result deletes its staged file, as the real registry does.
vi.mock("@/device-link/peerFileRegistry", () => ({
  releasePeerMedia: (uri: string) => {
    mocks.released.push(uri);
    mocks.contents.delete(uri);
  },
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts
        .map((p) => (typeof p === "string" ? p : p.uri))
        .join("/");
    }
    create() {}
    delete() {
      mocks.removed.push(this.uri);
      for (const key of mocks.contents.keys())
        if (key.startsWith(this.uri + "/")) mocks.contents.delete(key);
    }
  }
  class File extends Directory {
    get size() {
      return mocks.contents.get(this.uri)?.byteLength ?? 0;
    }
    async bytes() {
      return mocks.contents.get(this.uri);
    }
    // Asynchronous like expo-file-system's File.copy: the source is read after a tick.
    async copy(target: { uri: string }) {
      await new Promise((done) => setTimeout(done, 0));
      const source = mocks.contents.get(this.uri);
      if (!source) throw new Error("ENOENT");
      mocks.contents.set(target.uri, source);
    }
    write(text: string | Uint8Array) {
      mocks.contents.set(
        this.uri,
        typeof text === "string" ? new TextEncoder().encode(text) : text,
      );
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache", availableDiskSpace: 8 * 1024 * 1024 * 1024 } };
});
vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: (url: string, destination: string, _options: unknown, progress: unknown) => ({
    downloadAsync: () => mocks.download(url, destination, progress),
    pauseAsync: mocks.pause,
  }),
}));

import { prepareMobileHtmlPreview } from "@/session/mobileHtmlPreview";
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
afterEach(() => { vi.useRealTimers(); });

const html = "<h1>中文</h1>";
const bytes = new TextEncoder().encode(html);
const entry = (path: string) => ({
  name: path.split("/").pop(),
  relPath: path,
  size: bytes.length,
  type: "file",
});
function setup() {
  const listDir = vi
    .fn()
    .mockResolvedValue([entry("index.html"), entry("second.html")]);
  const caps = vi
    .fn()
    .mockResolvedValue({ ok: true, completeDirectoryListing: true });
  const deps = {
    maker: {
      fileBrowser: { caps, listDir },
    } as unknown as MobileMakerTransport,
    deviceId: "device-a",
    openLink: vi.fn().mockResolvedValue(undefined),
    presignGet: vi.fn(),
    deleteOssObject: vi.fn(),
  };
  return { deps, listDir, caps };
}
/** Files above the inline limit arrive as a staged local file owned by the peer registry. */
async function stagedDirectTransfer(_deps: unknown, path: string) {
  const url = "file:///peer/" + path.split("/").pop();
  mocks.contents.set(url, bytes);
  return { url, size: bytes.length };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sequence = 0;
  mocks.demand = false;
  mocks.listeners.clear();
  mocks.startOnDemand.mockResolvedValue("http://127.0.0.1:43123/__cindy/token");
  mocks.resolveRequest.mockResolvedValue(true);
  mocks.contents.clear();
  mocks.removed.length = 0;
  mocks.released.length = 0;
  mocks.start.mockResolvedValue("http://127.0.0.1:43123/__cindy/token");
  mocks.stop.mockResolvedValue(undefined);
  mocks.pause.mockResolvedValue(undefined);
  mocks.remote.mockImplementation(async (_deps, path, _ssh, onKey) => {
    onKey("key:" + path);
    return { url: "https://signed.invalid/file", size: bytes.length };
  });
  mocks.download.mockImplementation(async (_url, destination) => {
    mocks.contents.set(destination, bytes);
    return { status: 200 };
  });
});

function previewCache() {
  const saved = new Map<string, Uint8Array>();
  let manifest: ReturnType<typeof entry>[] | null = null;
  const cache = {
    current: () => true,
    copy: vi.fn(async (relative: string, destination: { uri: string }) => {
      const bytes = saved.get(relative);
      if (!bytes) return null;
      mocks.contents.set(destination.uri, bytes.slice());
      return bytes.length;
    }),
    store: vi.fn(async (relative: string, source: { uri: string }) => {
      saved.set(relative, mocks.contents.get(source.uri)!.slice());
    }),
    manifest: vi.fn(async () => manifest),
    storeManifest: vi.fn(async (_entry: string, files: ReturnType<typeof entry>[]) => { manifest = files; }),
  };
  mocks.cache.mockReturnValue(cache);
  return { cache, saved };
}

describe('persistent HTML preview cache', () => {
  // Unit regression: explicit reload previously restored stale bytes again. Both
  // native APIs must display fresh bytes on this attempt and preserve them for offline reopening.
  it.each([false, true])('bypasses cached bytes on explicit reload (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, listDir, caps } = setup();
    listDir.mockResolvedValue([entry('index.html')]);
    const { saved } = previewCache();
    const stale = new TextEncoder().encode('<p>old</p>');
    saved.set('index.html', stale);
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal, undefined, false);
    expect(new TextDecoder().decode(mocks.contents.get('file:///cache/html-previews/' + '01'.repeat(24) + '/0'))).toContain(html);
    expect(saved.get('index.html')).toEqual(bytes);
    await preview.close();
    mocks.remote.mockRejectedValue(new Error('offline'));
    caps.mockRejectedValue(new Error('offline'));
    const reopened = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(new TextDecoder().decode(mocks.contents.get('file:///cache/html-previews/' + '02'.repeat(24) + '/0'))).toContain(html);
    await reopened.close();
  });

  // Unit regression: old transfer-cache HTML can be invalid UTF-8 even after the
  // remote document is repaired. Exercise both native preparation entry points.
  it.each([false, true])('replaces undecodable cached entries and reopens offline (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, caps, listDir } = setup();
    listDir.mockResolvedValue([entry('index.html')]);
    const { saved } = previewCache();
    saved.set('index.html', new Uint8Array([0xff]));
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(saved.get('index.html')).toEqual(bytes);
    expect([...mocks.contents.values()].some((value) => new TextDecoder().decode(value).endsWith(html))).toBe(true);
    await preview.close();
    mocks.remote.mockRejectedValue(new Error('offline'));
    caps.mockRejectedValue(new Error('offline'));
    const reopened = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect([...mocks.contents.values()].some((value) => new TextDecoder().decode(value).endsWith(html))).toBe(true);
    await reopened.close();
  });

  it.each([false, true])('recovers an undecodable cached subpage without blocking the valid entry (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps } = setup();
    const { cache, saved } = previewCache();
    saved.set('index.html', bytes);
    saved.set('second.html', new Uint8Array([0xff]));
    cache.manifest.mockResolvedValue([entry('index.html'), entry('second.html')]);
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    if (demand) {
      mocks.listeners.get('resourceRequest')!({ token: '01'.repeat(24), id: 'second', path: 'second.html' });
      await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith('01'.repeat(24), 'second', expect.any(String), 'text/html', 200));
    } else {
      // Legacy servers publish only valid restored files; refresh repairs the next open.
      expect(mocks.start.mock.calls[0][4].map((item: string[]) => item[0])).toEqual(['index.html']);
    }
    await vi.waitFor(() => expect(saved.get('second.html')).toEqual(bytes));
    await preview.close();
  });

  it.each([false, true])('does not fetch after cancellation during an invalid cache copy (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, caps } = setup();
    const { cache } = previewCache();
    const controller = new AbortController();
    cache.copy.mockImplementation(async (_relative, destination) => {
      mocks.contents.set(destination.uri, new Uint8Array([0xff]));
      controller.abort();
      return 1;
    });
    await expect(prepareMobileHtmlPreview('/site/index.html', deps, controller.signal)).rejects.toThrow('PREVIEW_CANCELLED');
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(caps).not.toHaveBeenCalled();
    expect(mocks.contents.size).toBe(0);
  });

  // Behavioral timing contract: a cache hit must resolve before an unresolved remote operation.
  it.each([false, true])('opens cached content before network checks, including old native mode (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, caps } = setup();
    const { cache } = previewCache();
    const first = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    await first.close();
    mocks.start.mockClear(); mocks.startOnDemand.mockClear();
    let fail!: () => void;
    const waiting = new Promise<never>((_resolve, reject) => { fail = () => reject(new Error('offline')); });
    if (demand) mocks.remote.mockImplementation(() => waiting);
    else caps.mockImplementation(() => waiting);
    const second = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(demand ? mocks.startOnDemand : mocks.start).toHaveBeenCalledOnce();
    expect(cache.copy).toHaveBeenCalled();
    expect([...mocks.contents.values()].some((value) => new TextDecoder().decode(value).includes('<h1>中文</h1>'))).toBe(true);
    fail();
    await second.close();
  });

  it.each([false, true])('reports changed entry bytes after background refresh without mutating the visible copy (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, listDir } = setup();
    const { cache, saved } = previewCache();
    saved.set('index.html', bytes);
    const updated = new TextEncoder().encode('<p>Updated page</p>');
    listDir.mockResolvedValue([{ ...entry('index.html'), size: updated.length }]);
    mocks.remote.mockResolvedValue({ url: '', inlineBase64: btoa('<p>Updated page</p>'), size: updated.length });
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    const replacement = await preview.updated;
    expect(replacement).toBeTruthy();
    expect(replacement?.updated).toBeUndefined();
    expect(mocks.remote).toHaveBeenCalledOnce();
    expect(cache.store).toHaveBeenCalledOnce();
    expect(saved.get('index.html')).toEqual(updated);
    expect(new TextDecoder().decode(mocks.contents.get('file:///cache/html-previews/' + '01'.repeat(24) + '/0'))).toContain(html);
    expect(new TextDecoder().decode(mocks.contents.get('file:///cache/html-previews/' + '02'.repeat(24) + '/0'))).toContain('Updated page');
    // The visible replacement owns the whole visit, including its old server.
    await replacement!.close();
    expect(mocks.contents.size).toBe(0);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(mocks.listeners.size).toBe(0);
    mocks.remote.mockRejectedValue(new Error('offline'));
    const reopened = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(new TextDecoder().decode(mocks.contents.get('file:///cache/html-previews/' + '03'.repeat(24) + '/0'))).toContain('Updated page');
    await reopened.close();
  });

  it.each([false, true])('does not request a reload for identical HTML (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, listDir } = setup();
    listDir.mockResolvedValue([entry('index.html')]);
    previewCache().saved.set('index.html', bytes);
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(await preview.updated).toBeNull();
    await preview.close();
  });

  it.each([false, true])('discards a changed HTML refresh that finishes after leaving (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, listDir } = setup();
    previewCache().saved.set('index.html', bytes);
    const fresh = '<p>late</p>';
    listDir.mockResolvedValue([{ ...entry('index.html'), size: fresh.length }]);
    let finish!: () => void;
    mocks.remote.mockReturnValue(new Promise(resolve => {
      finish = () => resolve({ url: '', inlineBase64: btoa(fresh), size: fresh.length });
    }));
    const controller = new AbortController();
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, controller.signal);
    controller.abort();
    finish();
    expect(await preview.updated).toBeNull();
    await preview.close();
    expect(mocks.contents.size).toBe(0);
    expect(mocks.listeners.size).toBe(0);
  });

  it.each([false, true])('closes cached previews on account switch without waiting for a refresh (onDemand=%s)', async (demand) => {
    mocks.demand = demand;
    const { deps, caps } = setup();
    const { cache, saved } = previewCache();
    // No directory manifest: a missing companion cache must not hide the cached entry.
    saved.set('index.html', bytes);
    mocks.remote.mockRejectedValue(new Error('offline'));
    caps.mockRejectedValue(new Error('offline'));
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal);
    expect(demand ? mocks.startOnDemand : mocks.start).toHaveBeenCalledOnce();
    vi.spyOn(cache, 'current').mockReturnValue(false);
    setMobileAuthOwner('switched-owner-' + demand);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    await preview.close();
    expect(mocks.contents.size).toBe(0);
    expect(mocks.listeners.size).toBe(0);
    setMobileAuthOwner(null);
  });
});

describe("mobile HTML preview preparation", () => {
  it("serves inline HTML and an empty CSS file without an HTTP download", async () => {
    const { deps, listDir } = setup();
    listDir.mockResolvedValue([
      entry("index.html"),
      { ...entry("empty.css"), size: 0 },
    ]);
    mocks.remote.mockImplementation(async (_deps, file) => ({
      url: "data:text/plain;base64,",
      size: file.endsWith(".css") ? 0 : bytes.length,
      inlineBase64: file.endsWith(".css")
        ? ""
        : Buffer.from(bytes).toString("base64"),
    }));
    const preview = await prepareMobileHtmlPreview(
      "/site/index.html",
      deps,
      new AbortController().signal,
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(deps.deleteOssObject).not.toHaveBeenCalled();
    expect(
      [...mocks.contents.values()].some((content) => content.length === 0),
    ).toBe(true);
    await preview.close();
  });
  it("downloads original files once, guards every page and never exposes signed URLs", async () => {
    const { deps, listDir } = setup();
    const preview = await prepareMobileHtmlPreview(
      "/site/index.html",
      deps,
      new AbortController().signal,
    );
    expect(listDir).toHaveBeenCalledWith("/site", "", {
      includeIgnored: true,
      maxEntries: 2000,
    });
    expect(mocks.remote).toHaveBeenCalledWith(
      deps,
      "/site/index.html",
      undefined,
      expect.any(Function),
      { baseDir: "/site", maxBytes: bytes.length },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(mocks.start).toHaveBeenCalledTimes(1);
    for (const content of mocks.contents.values()) {
      const document = new TextDecoder().decode(content);
      expect(document).toContain("Content-Security-Policy");
      expect(document).toContain("RTCPeerConnection");
      expect(document.endsWith(html)).toBe(true);
      expect(document).not.toContain("signed.invalid");
    }
    expect(deps.deleteOssObject).toHaveBeenCalledTimes(2);
    expect(preview.documents).toEqual(["/index.html", "/", "/second.html"]);
    await preview.close();
    await preview.close();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.contents.size).toBe(0);
  });
  it("finishes copying direct-transfer files before releasing their staged source", async () => {
    const { deps } = setup();
    mocks.remote.mockImplementation(stagedDirectTransfer);
    const preview = await prepareMobileHtmlPreview(
      "/site/index.html",
      deps,
      new AbortController().signal,
    );
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.released).toEqual([
      "file:///peer/index.html",
      "file:///peer/second.html",
    ]);
    expect(mocks.contents.size).toBe(2);
    for (const content of mocks.contents.values())
      expect(new TextDecoder().decode(content)).toContain("Content-Security-Policy");
    await preview.close();
  });
  it("rejects old peers before enumeration or download", async () => {
    const { deps, caps, listDir } = setup();
    caps.mockResolvedValue({ ok: true });
    await expect(
      prepareMobileHtmlPreview(
        "/site/index.html",
        deps,
        new AbortController().signal,
      ),
    ).rejects.toThrow("COMPLETE_DIRECTORY_LISTING_UNSUPPORTED");
    expect(listDir).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
  });
  it("retains the SSH session workdir for listing and SSH identity for fetching", async () => {
    const { deps, listDir } = setup();
    listDir.mockResolvedValue([entry("site/index.html")]);
    const ssh = {
      workdir: "/project",
      remoteHostId: "ssh-a",
      sessionId: "session-a",
    };
    const preview = await prepareMobileHtmlPreview(
      "/project/site/index.html",
      { ...deps, ssh },
      new AbortController().signal,
    );
    expect(listDir).toHaveBeenCalledWith(
      "/project",
      "site",
      expect.objectContaining({ includeIgnored: true }),
    );
    expect(mocks.remote.mock.calls[0][2]).toEqual(ssh);
    await preview.close();
  });
  it.each(["presign", "download", "changed", "native"])(
    "cleans failed %s preparations without publishing partial snapshots",
    async (failure) => {
      const { deps } = setup();
      if (failure === "presign")
        mocks.remote.mockImplementation(async (_d, _p, _s, onKey) => {
          onKey("first");
          onKey("retried");
          throw new Error("presign");
        });
      if (failure === "download")
        mocks.download.mockRejectedValue(new Error("download"));
      if (failure === "changed")
        mocks.download.mockImplementation(async (_u, destination) => {
          mocks.contents.set(destination, new Uint8Array(1));
          return { status: 200 };
        });
      if (failure === "native")
        mocks.start.mockRejectedValue(new Error("native"));
      await expect(
        prepareMobileHtmlPreview(
          "/site/index.html",
          deps,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(deps.deleteOssObject).toHaveBeenCalled();
      if (failure === "presign")
        expect(deps.deleteOssObject.mock.calls).toEqual([
          ["first"],
          ["retried"],
        ]);
      if (failure !== "native") expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.removed).toHaveLength(1);
      expect(mocks.contents.size).toBe(0);
    },
  );
  it("cancels pending downloads and closes a listener if cancellation races its startup", async () => {
    const { deps } = setup();
    const controller = new AbortController();
    mocks.start.mockImplementation(async () => {
      controller.abort();
      return "http://127.0.0.1:43123/";
    });
    await expect(
      prepareMobileHtmlPreview("/site/index.html", deps, controller.signal),
    ).rejects.toThrow();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.contents.size).toBe(0);
  });
});


describe("on-demand mobile HTML previews", () => {
  const token = "01".repeat(24);
  const request = (id: string, path: string) => mocks.listeners.get("resourceRequest")!({ token, id, path });
  beforeEach(() => { mocks.demand = true; });

  // Unit regression: a slow entry must finish before WebView can request it. Previously
  // preparation returned immediately, leaving WebKit's request waiting on the network.
  it("keeps a slow entry in preparation, reports bytes, then serves it without another download", async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    let finish!: () => void;
    const progress = vi.fn();
    mocks.remote.mockImplementation(async (...args) => {
      args[6]?.(4, bytes.length);
      await new Promise<void>((resolve) => { finish = resolve; });
      return { url: "data:text/html;base64,", size: bytes.length, inlineBase64: Buffer.from(bytes).toString("base64") };
    });
    const preparing = prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal, progress);
    await vi.waitFor(() => expect(mocks.remote).toHaveBeenCalledOnce());
    expect(mocks.startOnDemand).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ name: "index.html", loaded: 4, total: bytes.length }));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.startOnDemand).not.toHaveBeenCalled();
    finish();
    const preview = await preparing;
    request("entry", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "entry", "0", "text/html", 200));
    expect(mocks.remote).toHaveBeenCalledOnce();
    await preview.close();
  });

  it.each([false, true])('reports actual download speed on old and on-demand binaries: %s', async (demand) => {
    vi.useFakeTimers();
    mocks.demand = demand;
    const { deps, listDir } = setup();
    listDir.mockResolvedValue([entry('index.html')]);
    const progress = vi.fn();
    mocks.download.mockImplementation(async (_url, destination, report) => {
      vi.setSystemTime(Date.now() + 1000);
      report({ totalBytesWritten: 4, totalBytesExpectedToWrite: -1 });
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ loaded: 4, total: bytes.length, bytesPerSecond: 4 }));
      mocks.contents.set(destination, bytes);
      return { status: 200 };
    });
    const preview = await prepareMobileHtmlPreview('/site/index.html', deps, new AbortController().signal, progress);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ loaded: bytes.length, total: bytes.length }));
    await preview.close();
  });

  it('cancels entry preparation before opening a server and releases a late direct file', async () => {
    const { deps } = setup();
    const controller = new AbortController();
    const progress = vi.fn();
    let finish!: () => void;
    mocks.remote.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return stagedDirectTransfer(null, '/site/index.html');
    });
    const preparing = prepareMobileHtmlPreview('/site/index.html', deps, controller.signal, progress);
    const rejected = expect(preparing).rejects.toThrow('PREVIEW_CANCELLED');
    await vi.waitFor(() => expect(mocks.remote).toHaveBeenCalledOnce());
    controller.abort();
    progress.mockClear();
    finish();
    await rejected;
    expect(mocks.startOnDemand).not.toHaveBeenCalled();
    expect(mocks.released).toEqual(['file:///peer/index.html']);
    expect(mocks.contents.size).toBe(0);
    expect(mocks.listeners.size).toBe(0);
    expect(progress).not.toHaveBeenCalled();
  });

  it("prepares only the entry without listing, then fetches requested resources", async () => {
    const { deps, listDir, caps } = setup();
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    expect(preview.onDemand).toBe(true);
    expect(listDir).not.toHaveBeenCalled();
    expect(caps).not.toHaveBeenCalled();
    expect(mocks.remote).toHaveBeenCalledOnce();
    request("a", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "a", "0", "text/html", 200));
    expect(mocks.remote).toHaveBeenCalledWith(deps, "/site/index.html", undefined, expect.any(Function),
      { baseDir: "/site", maxBytes: 2 * 1024 * 1024 * 1024 }, expect.any(AbortSignal), expect.any(Function));
    expect(new TextDecoder().decode([...mocks.contents.values()][0])).toContain("Content-Security-Policy");
    expect(deps.deleteOssObject).toHaveBeenCalledOnce();
    await preview.close();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.contents.size).toBe(0);
  });

  it("serves a direct-transfer resource only after its copy completes", async () => {
    const { deps } = setup();
    mocks.remote.mockImplementation(stagedDirectTransfer);
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    request("a", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "a", "0", "text/html", 200));
    expect(mocks.released).toEqual(["file:///peer/index.html"]);
    expect(mocks.contents.size).toBe(1);
    expect(new TextDecoder().decode([...mocks.contents.values()][0])).toContain("Content-Security-Policy");
    await preview.close();
  });

  it("reuses a materialized path instead of fetching cache-busted repeats", async () => {
    const { deps } = setup();
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    request("a", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "a", "0", "text/html", 200));
    request("b", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "b", "0", "text/html", 200));
    expect(mocks.remote).toHaveBeenCalledOnce();
    await preview.close();
  });

  it("isolates missing resources and refuses paths outside the preview root", async () => {
    const { deps } = setup();
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    mocks.remote.mockRejectedValueOnce(new Error("NOT_FOUND"));
    request("missing", "missing.js");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "missing", "", "", 404));
    request("escape", "../secret.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "escape", "", "", 404));
    expect(mocks.remote).toHaveBeenCalledTimes(2);
    request("page", "second.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "page", "2", "text/html", 200));
    await preview.close();
  });

  it("cancels closed requests before publishing and drains cleanup before removing its directory", async () => {
    const { deps } = setup();
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    mocks.download.mockClear();
    mocks.remote.mockClear();
    deps.deleteOssObject.mockClear();
    let finish!: (value: { status: number }) => void;
    mocks.download.mockImplementation((_url, destination) => {
      mocks.contents.set(destination, bytes);
      return new Promise((resolve) => { finish = resolve; });
    });
    request("active", "second.html");
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    request("queued", "third.html");
    const closing = preview.close();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.removed).toHaveLength(0);
    finish({ status: 200 });
    await closing;
    expect(mocks.remote).toHaveBeenCalledOnce();
    expect(mocks.resolveRequest).not.toHaveBeenCalled();
    expect(mocks.contents.size).toBe(0);
    expect(deps.deleteOssObject).toHaveBeenCalledOnce();
  });

  it("keeps SSH identity and rejects an entry outside its workdir", async () => {
    const { deps } = setup();
    const ssh = { workdir: "/project", remoteHostId: "ssh-a", sessionId: "session-a" };
    await expect(prepareMobileHtmlPreview("/other/index.html", { ...deps, ssh }, new AbortController().signal)).rejects.toThrow("OUTSIDE_WORKDIR");
    const preview = await prepareMobileHtmlPreview("/project/site/index.html", { ...deps, ssh }, new AbortController().signal);
    request("ssh", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledOnce());
    expect(mocks.remote.mock.calls[0][2]).toEqual(ssh);
    await preview.close();
  });
});
