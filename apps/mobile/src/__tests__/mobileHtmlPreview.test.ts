import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contents: new Map<string, Uint8Array>(),
  removed: [] as string[],
  remote: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  download: vi.fn(),
  pause: vi.fn(),
  demand: false,
  startOnDemand: vi.fn(),
  resolveRequest: vi.fn(),
  listeners: new Map<string, (event: { token: string; id: string; path?: string }) => void>(),
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: () => new Uint8Array(24).fill(1),
}));
vi.mock("../../modules/cindy-html-preview/src/CindyHtmlPreviewModule", () => ({
  default: {
    start: mocks.start, stop: mocks.stop,
    get startOnDemand() { return mocks.demand ? mocks.startOnDemand : undefined; },
    get resolveRequest() { return mocks.demand ? mocks.resolveRequest : undefined; },
    addListener: (event: string, listener: (event: { token: string; id: string; path?: string }) => void) => {
      mocks.listeners.set(event, listener);
      return { remove: () => mocks.listeners.delete(event) };
    },
  },
}));
vi.mock("@/session/remoteAbsFileFetch", () => ({
  fetchRemoteAbsFileOnce: mocks.remote,
}));
vi.mock("@/device-link/remoteRetry", () => ({
  withTransientRemoteRetry: (operation: () => unknown) => operation(),
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
  createDownloadResumable: (url: string, destination: string) => ({
    downloadAsync: () => mocks.download(url, destination),
    pauseAsync: mocks.pause,
  }),
}));

import { prepareMobileHtmlPreview } from "@/session/mobileHtmlPreview";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";

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
beforeEach(() => {
  vi.resetAllMocks();
  mocks.demand = false;
  mocks.listeners.clear();
  mocks.startOnDemand.mockResolvedValue("http://127.0.0.1:43123/__cindy/token");
  mocks.resolveRequest.mockResolvedValue(true);
  mocks.contents.clear();
  mocks.removed.length = 0;
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

  it("opens without listing or downloading, then fetches only requested resources", async () => {
    const { deps, listDir, caps } = setup();
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    expect(preview.onDemand).toBe(true);
    expect(listDir).not.toHaveBeenCalled();
    expect(caps).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    request("a", "index.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "a", "0", "text/html", 200));
    expect(mocks.remote).toHaveBeenCalledWith(deps, "/site/index.html", undefined, expect.any(Function),
      { baseDir: "/site", maxBytes: 2 * 1024 * 1024 * 1024 }, expect.any(AbortSignal));
    expect(new TextDecoder().decode([...mocks.contents.values()][0])).toContain("Content-Security-Policy");
    expect(deps.deleteOssObject).toHaveBeenCalledOnce();
    await preview.close();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.contents.size).toBe(0);
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
    expect(mocks.remote).toHaveBeenCalledOnce();
    request("page", "second.html");
    await vi.waitFor(() => expect(mocks.resolveRequest).toHaveBeenCalledWith(token, "page", "1", "text/html", 200));
    await preview.close();
  });

  it("cancels closed requests before publishing and drains cleanup before removing its directory", async () => {
    const { deps } = setup();
    let finish!: (value: { status: number }) => void;
    mocks.download.mockImplementation((_url, destination) => {
      mocks.contents.set(destination, bytes);
      return new Promise((resolve) => { finish = resolve; });
    });
    const preview = await prepareMobileHtmlPreview("/site/index.html", deps, new AbortController().signal);
    request("active", "index.html");
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    request("queued", "second.html");
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
