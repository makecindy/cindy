import { describe, expect, it, vi } from "vitest";
import {
  ClipboardSync,
  clipboardDigest,
  type ClipboardSyncDeps,
  type ClipboardSyncBaseline,
  type LocalClipboardReadCache,
} from "./clipboardSync";
import type { RemoteDesktopRequest } from "@cindy/device-link";

function harness() {
  let local = "1",
    remote = "1",
    current = true;
  let localJson = JSON.stringify({ text: "local-1" });
  let remoteJson = JSON.stringify({ text: "remote-1" });
  let buffer = "";
  const request = vi.fn(
    async (message: RemoteDesktopRequest): Promise<unknown> => {
      if (message.op === "clipboardVersion") return { version: remote };
      if (message.op !== "clipboardContent") return {};
      if (message.action === "copy")
        return message.inline
          ? { data: remoteJson, length: remoteJson.length }
          : { id: "transfer", length: remoteJson.length };
      if (message.action === "begin") {
        buffer = "";
        return { id: "transfer" };
      }
      if (message.action === "read")
        return {
          data: remoteJson.slice(message.offset, message.offset + 65536),
        };
      if (message.action === "write") buffer += message.data;
      if (message.action === "commit" || message.action === "paste") {
        remoteJson = message.action === "paste" ? message.data : buffer;
        remote = "3";
        return { version: remote };
      }
      return { ok: true };
    },
  );
  const write = vi.fn(async (json: string, version: string) => {
    if (local !== version) throw new Error("CLIPBOARD_CHANGED");
    local = "3";
    localJson = json;
    return local;
  });
  const deps: ClipboardSyncDeps = {
    lease: "lease",
    request: request as ClipboardSyncDeps["request"],
    current: () => current,
    localVersion: async () => local,
    readLocal: vi.fn(async () => localJson),
    writeLocal: write,
  };
  return {
    engine: new ClipboardSync(deps),
    deps,
    request,
    write,
    local: (
      value: string,
      json = JSON.stringify({ text: `local-${value}` }),
    ) => {
      local = value;
      localJson = json;
    },
    remote: (
      value: string,
      json = JSON.stringify({ text: `remote-${value}` }),
    ) => {
      remote = value;
      remoteJson = json;
    },
    stop: () => {
      current = false;
    },
  };
}
describe("automatic clipboard synchronization", () => {
  it("skips an unsupported computer snapshot until its counter changes", async () => {
    const h = harness();
    await h.engine.tick();
    h.request.mockClear();
    h.remote("2");
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (message) => {
      if (message.op === "clipboardContent" && message.action === "copy")
        throw new Error("CLIPBOARD_UNSUPPORTED");
      return original(message);
    });
    await expect(h.engine.tick()).resolves.toBeUndefined();
    await expect(h.engine.tick()).resolves.toBeUndefined();
    expect(
      h.request.mock.calls.filter(
        ([r]) => r.op === "clipboardContent" && r.action === "copy",
      ),
    ).toHaveLength(1);
    expect(h.write).not.toHaveBeenCalled();
    h.request.mockImplementation(original);
    h.remote("4");
    await h.engine.tick();
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it.each(["CLIPBOARD_UNSUPPORTED", "CLIPBOARD_TOO_LONG"])(
    "skips %s once, then transfers the next copy",
    async (code) => {
      const h = harness();
      const trace = vi.fn();
      const engine = new ClipboardSync({ ...h.deps, trace });
      vi.mocked(h.deps.readLocal).mockRejectedValueOnce(new Error(code));
      await engine.tick();
      await engine.tick();
      expect(h.deps.readLocal).toHaveBeenCalledTimes(1);
      expect(trace).toHaveBeenCalledWith("content-skipped");
      h.local("2");
      await engine.tick();
      expect(
        h.request.mock.calls.some(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ),
      ).toBe(true);
    },
  );
  it("reuses only a successful read of the same local version on a new connection", async () => {
    const h = harness();
    const localReadCache: LocalClipboardReadCache = {};
    const deps = { ...h.deps, localReadCache };
    await new ClipboardSync(deps).tick();
    await new ClipboardSync(deps).tick();
    expect(h.deps.readLocal).toHaveBeenCalledTimes(1);
    h.local("2");
    await new ClipboardSync(deps).tick();
    expect(h.deps.readLocal).toHaveBeenCalledTimes(2);
  });
  it("does not remember denied permission as a successful read", async () => {
    const h = harness();
    const localReadCache: LocalClipboardReadCache = {};
    vi.mocked(h.deps.readLocal).mockRejectedValueOnce(
      new Error("PASTE_DENIED"),
    );
    await expect(
      new ClipboardSync({ ...h.deps, localReadCache }).tick(),
    ).rejects.toThrow("PASTE_DENIED");
    expect(localReadCache.version).toBeUndefined();
    await new ClipboardSync({ ...h.deps, localReadCache }).tick();
    expect(h.deps.readLocal).toHaveBeenCalledTimes(2);
  });
  it.each(["local", "remote"] as const)(
    "transfers small %s content inline and verifies destination normalization",
    async (direction) => {
      const h = harness();
      const engine = new ClipboardSync({ ...h.deps, inline: true });
      await engine.tick();
      h.request.mockClear();
      h[direction]("2");
      await engine.tick();
      const payloads = h.request.mock.calls.filter(
        ([r]) => r.op === "clipboardContent",
      );
      expect(payloads).toHaveLength(direction === "local" ? 2 : 1);
      if (direction === "local")
        expect(payloads[1][0]).toMatchObject({ action: "copy", inline: true });
      expect(payloads[0][0]).toMatchObject({
        action: direction === "local" ? "paste" : "copy",
      });
    },
  );
  it("keeps large payloads chunked even when inline is supported", async () => {
    const h = harness();
    const engine = new ClipboardSync({ ...h.deps, inline: true });
    await engine.tick();
    h.local("2", JSON.stringify({ text: "x".repeat(130000) }));
    await engine.tick();
    expect(
      h.request.mock.calls.filter(
        ([r]) => r.op === "clipboardContent" && r.action === "write",
      ),
    ).toHaveLength(2);
    expect(
      h.request.mock.calls.some(
        ([r]) => r.op === "clipboardContent" && r.action === "paste",
      ),
    ).toBe(false);
  });
  it("ignores key order but preserves different rich representations in its digest", () => {
    expect(clipboardDigest('{"text":"a","html":"<b>a</b>"}')).toBe(
      clipboardDigest('{"html":"<b>a</b>","text":"a"}'),
    );
    expect(clipboardDigest('{"text":"a"}')).not.toBe(
      clipboardDigest('{"text":"a","html":"<b>a</b>"}'),
    );
  });
  it("does not resend identical copies or report identical concurrent copies as a conflict", async () => {
    const h = harness();
    await h.engine.tick();
    h.request.mockClear();
    h.local("2", '{"text":"local-1"}');
    await h.engine.tick();
    expect(
      h.request.mock.calls.some(([r]) => r.op === "clipboardContent"),
    ).toBe(false);
    h.local("3", '{"text":"same"}');
    h.remote("2", '{"text":"same"}');
    await h.engine.tick();
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([r]) => r.op === "clipboardContent" && r.action === "commit",
      ),
    ).toBe(false);
  });
  it.each(["local", "remote"] as const)(
    "syncs the next %s copy after preserving a conflict",
    async (direction) => {
      const h = harness();
      await h.engine.tick();
      h.local("2");
      h.remote("2");
      await expect(h.engine.tick()).rejects.toThrow("CLIPBOARD_CONFLICT");
      expect(h.write).not.toHaveBeenCalled();
      await h.engine.tick();
      h[direction]("4");
      await h.engine.tick();
      await h.engine.tick();
      expect(h.write).toHaveBeenCalledTimes(direction === "remote" ? 1 : 0);
      expect(
        h.request.mock.calls.filter(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ),
      ).toHaveLength(direction === "local" ? 1 : 0);
    },
  );
  it.each(["local", "remote"] as const)(
    "retains a %s copy made while the app is paused across lease replacement",
    async (direction) => {
      const h = harness();
      const baseline: ClipboardSyncBaseline = { local: "", remote: "" };
      await new ClipboardSync(h.deps, baseline).tick();
      h[direction]("2");
      const resumed = new ClipboardSync(
        { ...h.deps, lease: "resumed" },
        baseline,
      );
      await resumed.tick();
      await resumed.tick();
      expect(h.write).toHaveBeenCalledTimes(direction === "remote" ? 1 : 0);
      expect(
        h.request.mock.calls.filter(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ),
      ).toHaveLength(direction === "local" ? 1 : 0);
    },
  );
  it("reads both initial digests without writing existing contents on opt-in", async () => {
    const h = harness();
    await h.engine.tick();
    await h.engine.tick();
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([request]) =>
          request.op === "clipboardContent" &&
          ["begin", "write", "commit", "paste"].includes(request.action),
      ),
    ).toBe(false);
  });
  it("ignores a computer counter-only rewrite immediately after opt-in", async () => {
    const h = harness();
    await h.engine.tick();
    h.remote("2", JSON.stringify({ text: "remote-1" }));
    await h.engine.tick();
    expect(h.write).not.toHaveBeenCalled();
    h.remote("3");
    await h.engine.tick();
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it("does not commit a baseline if local content changes during the remote read", async () => {
    const h = harness();
    const baseline: ClipboardSyncBaseline = { local: "", remote: "" };
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (message) => {
      if (message.op === "clipboardContent" && message.action === "copy")
        h.local("2");
      return original(message);
    });
    await expect(new ClipboardSync(h.deps, baseline).tick()).rejects.toThrow(
      "CLIPBOARD_CHANGED",
    );
    expect(baseline.local).toBe("");
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each(["local", "remote"] as const)(
    "syncs a %s change once without echoing its own write",
    async (direction) => {
      const h = harness();
      await h.engine.tick();
      h[direction]("2");
      await h.engine.tick();
      await h.engine.tick();
      expect(
        h.request.mock.calls.filter(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ),
      ).toHaveLength(direction === "local" ? 1 : 0);
      expect(h.write).toHaveBeenCalledTimes(direction === "remote" ? 1 : 0);
    },
  );
  it("does not echo a delayed Android notification for its own write", async () => {
    const h = harness();
    await h.engine.tick();
    const copied = JSON.stringify({ text: "remote-copy" });
    h.remote("2", copied);
    await h.engine.tick();
    expect(h.write).toHaveBeenCalledTimes(1);
    h.request.mockClear();
    // setPrimaryClip returned its new token before the platform callback ran.
    h.local("4", copied);
    await h.engine.tick();
    await h.engine.tick();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(
      h.request.mock.calls.every(([r]) => r.op === "clipboardVersion"),
    ).toBe(true);
    // A later real copy still propagates after that counter-only notification.
    h.local("5");
    await h.engine.tick();
    expect(
      h.request.mock.calls.filter(
        ([r]) => r.op === "clipboardContent" && r.action === "commit",
      ),
    ).toHaveLength(1);
  });
  it("preserves concurrent local and remote copies", async () => {
    const h = harness();
    await h.engine.tick();
    h.local("2");
    h.remote("2");
    await expect(h.engine.tick()).rejects.toThrow("CLIPBOARD_CONFLICT");
    expect(h.write).not.toHaveBeenCalled();
  });
  it("does not write a remote result after leaving the foreground", async () => {
    const h = harness();
    await h.engine.tick();
    h.remote("2");
    h.request.mockImplementation(async (message: RemoteDesktopRequest) => {
      if (message.op === "clipboardVersion") return { version: "2" };
      if (message.op === "clipboardContent" && message.action === "copy") {
        h.stop();
        return { id: "transfer", length: 12 };
      }
      return {};
    });
    await expect(h.engine.tick()).rejects.toThrow("DESKTOP_LEASE_EXPIRED");
    expect(h.write).not.toHaveBeenCalled();
  });
  it("distinguishes a real new copy from a counter-only change on the other device", async () => {
    const h = harness();
    await h.engine.tick();
    h.local("2");
    await h.engine.tick();
    h.request.mockClear();
    h.local("4");
    h.remote("5", JSON.stringify({ text: "local-2" }));
    await h.engine.tick();
    expect(
      h.request.mock.calls.filter(
        ([r]) => r.op === "clipboardContent" && r.action === "commit",
      ),
    ).toHaveLength(1);
    expect(h.write).not.toHaveBeenCalled();
  });
});

it.each(["local", "remote"] as const)(
  "keeps the other digest after skipping an unsupported %s version",
  async (failed) => {
    const h = harness();
    await h.engine.tick();
    h[failed]("2");
    if (failed === "local") {
      vi.mocked(h.deps.readLocal).mockRejectedValueOnce(
        new Error("CLIPBOARD_UNSUPPORTED"),
      );
    } else {
      const original = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (message) => {
        if (message.op === "clipboardContent" && message.action === "copy")
          throw new Error("CLIPBOARD_UNSUPPORTED");
        return original(message);
      });
    }
    await h.engine.tick();
    const other = failed === "local" ? "remote" : "local";
    h[other]("4", JSON.stringify({ text: `${other}-1` }));
    await h.engine.tick();
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([r]) => r.op === "clipboardContent" && r.action === "commit",
      ),
    ).toBe(false);
    h[other]("5");
    await h.engine.tick();
    expect(
      h.write.mock.calls.length +
        h.request.mock.calls.filter(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ).length,
    ).toBe(1);
  },
);
it("retains a successfully read new local digest when the remote read is unsupported", async () => {
  const h = harness();
  const baseline: ClipboardSyncBaseline = { local: "", remote: "" };
  const engine = new ClipboardSync(h.deps, baseline);
  await engine.tick();
  h.local("2");
  h.remote("2");
  const original = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (message) => {
    if (message.op === "clipboardContent" && message.action === "copy")
      throw new Error("CLIPBOARD_UNSUPPORTED");
    return original(message);
  });
  await engine.tick();
  expect(baseline.localDigest).toBe(
    clipboardDigest(JSON.stringify({ text: "local-2" })),
  );
  expect(baseline.remoteDigest).toBeUndefined();
});

it.each(["local", "remote"] as const)(
  "does not echo normalized content after writing to %s",
  async (destination) => {
    const h = harness();
    await h.engine.tick();
    const source = JSON.stringify({
      text: "rich",
      html: "<b>rich</b>",
      rtf: "rtf rich",
    });
    const normalized = JSON.stringify({ text: "rich", html: "<b>rich</b>" });
    if (destination === "local") {
      const write = h.write.getMockImplementation()!;
      h.write.mockImplementation((_, version) => write(normalized, version));
      h.remote("2", source);
    } else {
      const original = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (message) => {
        const result = await original(message);
        if (message.op === "clipboardContent" && message.action === "commit")
          h.remote("3", normalized);
        return result;
      });
      h.local("2", source);
    }
    await h.engine.tick();
    h.request.mockClear();
    h.write.mockClear();
    h[destination]("4", normalized); // delayed native notification
    await h.engine.tick();
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([r]) => r.op === "clipboardContent" && r.action === "commit",
      ),
    ).toBe(false);
    h[destination]("5"); // a real subsequent copy still propagates
    await h.engine.tick();
    expect(
      h.write.mock.calls.length +
        h.request.mock.calls.filter(
          ([r]) => r.op === "clipboardContent" && r.action === "commit",
        ).length,
    ).toBe(1);
  },
);
