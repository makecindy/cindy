import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
const files = vi.hoisted(() => ({
  write: vi.fn(),
  remove: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
  append: vi.fn(),
  clear: vi.fn(),
  copy: vi.fn(),
  prune: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("./mobileDebugFiles", () => ({
  appendMobileDebugFile: files.append,
  clearMobileDebugFiles: files.clear,
  copyMobileDebugFiles: files.copy,
  pruneMobileDebugFiles: files.prune,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri = "file:///cache/cindy-diagnostics.json";
    exists = true;
    write = files.write;
    delete = files.remove;
  },
  Paths: { cache: "file:///cache" },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: files.available,
  shareAsync: files.share,
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: lifecycle.listen,
  },
}));
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_CINDY_DIAGNOSTICS", "1");
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
  files.write.mockReset();
  files.append.mockReset();
  files.clear.mockReset();
  files.copy.mockReset();
  files.prune.mockReset();
  lifecycle.listen.mockReset().mockReturnValue({ remove() {} });
  files.remove.mockReset();
  files.share.mockReset().mockResolvedValue(undefined);
  files.available.mockReset().mockResolvedValue(true);
});
describe("local journal persistence", () => {
  it.each([false, true])(
    "stops collection throughout a delayed opt-out (save fails: %s)",
    async (fails) => {
      vi.useFakeTimers();
      const log = await import("./localDiagnostics");
      const debug = await import("./mobileDebugLog");
      const stop = log.startLocalDiagnostics();
      await log.hydrateDiagnostics();
      await log.flushDiagnostics();
      const before = await log.diagnosticSnapshot();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      storage.setItem.mockImplementationOnce(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const pending = log.setDiagnosticsEnabled(false);
      const outcome = pending.catch(() => {});
      expect(debug.mobileDebugEnabled()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(4000);
      debug.mobileDebugLog("debug", "recovery", "after opt-out");
      log.recordDiagnostic("relay connection error");
      if (fails) reject(new Error("save failed"));
      else resolve();
      await outcome;
      expect(log.diagnosticsEnabled()).toBe(fails);
      await log.flushDiagnostics();
      expect(
        files.append.mock.calls.map(([batch]) => batch).join(""),
      ).not.toContain("after opt-out");
      expect(await log.diagnosticSnapshot()).toEqual(before);
      expect(vi.getTimerCount()).toBe(fails ? 1 : 0);
      stop();
    },
  );
  it("prunes on disabled startup and foreground without recording or starting a probe", async () => {
    vi.useFakeTimers();
    storage.getItem.mockResolvedValue(
      JSON.stringify({ enabled: false, events: [] }),
    );
    files.prune.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const log = await import("./localDiagnostics");
    const stop = log.startLocalDiagnostics();
    await log.hydrateDiagnostics();
    await log.flushDiagnostics();
    expect(files.prune).toHaveBeenCalledTimes(1);
    const change = lifecycle.listen.mock.calls[0][1];
    change("background");
    change("active");
    await log.flushDiagnostics();
    expect(files.prune).toHaveBeenCalledTimes(2);
    expect(files.append).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it.each([false, true])(
    "keeps the previous preference when saving %s fails",
    async (next) => {
      storage.getItem.mockResolvedValue(
        JSON.stringify({ enabled: !next, events: [] }),
      );
      const log = await import("./localDiagnostics");
      await log.hydrateDiagnostics();
      storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(log.setDiagnosticsEnabled(next)).rejects.toThrow(
        "storage unavailable",
      );
      expect(log.diagnosticsEnabled()).toBe(!next);
      await log.flushDiagnostics();
      expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).enabled).toBe(
        !next,
      );
    },
  );
  it("runs no probe while off and stops it immediately after a durable opt-out", async () => {
    vi.useFakeTimers();
    vi.stubEnv("EXPO_PUBLIC_CINDY_DIAGNOSTICS", "0");
    const log = await import("./localDiagnostics");
    const stop = log.startLocalDiagnostics();
    await log.hydrateDiagnostics();
    expect(vi.getTimerCount()).toBe(0);
    await log.setDiagnosticsEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      files.append.mock.calls.some(([batch]) =>
        batch.includes("render metrics"),
      ),
    ).toBe(true);
    await log.setDiagnosticsEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("persists detailed local errors but exposes only the whitelist to upload", async () => {
    const log = await import("./localDiagnostics");
    const debug = await import("./mobileDebugLog");
    await log.hydrateDiagnostics();
    debug.mobileDebugLog(
      "error",
      "device-link",
      "relay connection error",
      new Error("socket timed out Bearer hidden-secret"),
    );
    debug.mobileDebugLog("debug", "recovery", "snapshot applied", {
      elapsedMs: 456,
      count: 12,
    });
    await log.flushDiagnostics();
    const batch = files.append.mock.calls[0][0];
    expect(batch).toContain("socket timed out");
    expect(batch).toContain("snapshot applied");
    expect(batch).not.toContain("hidden-secret");
    expect(await log.diagnosticSnapshot()).toEqual([
      { at: expect.any(Number), event: "relay connection error", fields: {} },
    ]);
    await log.setDiagnosticsEnabled(false);
    files.append.mockClear();
    debug.mobileDebugLog("debug", "scroll", "disabled event");
    await log.flushDiagnostics();
    expect(files.append).not.toHaveBeenCalled();
  });
  it("bounds detailed buffers while disk is slow and records the overflow", async () => {
    const log = await import("./localDiagnostics");
    const { mobileDebugLog } = await import("./mobileDebugLog");
    await log.hydrateDiagnostics();
    let release!: () => void;
    storage.setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mobileDebugLog("debug", "recovery", "start");
    const first = log.flushDiagnostics();
    await Promise.resolve();
    for (let i = 0; i < 180; i++)
      mobileDebugLog("debug", "recovery", "x".repeat(4000));
    const later = log.flushDiagnostics();
    expect(files.append).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, later]);
    expect(files.append).toHaveBeenCalledTimes(2);
    expect(files.append.mock.calls[1][0].length).toBeLessThan(513 * 1024);
    expect(files.append.mock.calls[1][0]).toContain("debug records lost");
  });
  it("recovers after file failure and reports a gap without blocking the opt-out", async () => {
    const log = await import("./localDiagnostics");
    const { mobileDebugLog } = await import("./mobileDebugLog");
    await log.hydrateDiagnostics();
    mobileDebugLog("debug", "recovery", "failed batch");
    files.append.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(log.setDiagnosticsEnabled(false)).rejects.toThrow("disk full");
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).enabled).toBe(
      false,
    );
    await log.flushDiagnostics();
    expect(files.append.mock.calls.at(-1)![0]).toContain("debug records lost");
  });
  it("turns recording off without clearing retained logs", async () => {
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    log.recordDiagnostic("app active");
    await log.setDiagnosticsEnabled(false);
    expect(log.diagnosticsEnabled()).toBe(false);
    const saved = JSON.parse(storage.setItem.mock.calls.at(-1)![1]);
    expect(saved.enabled).toBe(false);
    expect(saved.events).toHaveLength(1);
  });
  it.each([false, true])(
    "cleans the export cache after sharing (failure=%s)",
    async (fails) => {
      const log = await import("./localDiagnostics");
      await log.hydrateDiagnostics();
      log.recordDiagnostic(
        "relay connection error",
        new Error("private token"),
      );
      if (fails) files.share.mockRejectedValueOnce(new Error("share failed"));
      if (fails)
        await expect(log.exportDiagnostics()).rejects.toThrow("share failed");
      else await log.exportDiagnostics();
      expect(files.remove).toHaveBeenCalledOnce();
      expect(files.copy).toHaveBeenCalledOnce();
      await log.exportDiagnostics();
      expect(files.share).toHaveBeenCalledTimes(2);
    },
  );
  it("is off by default in normal builds", async () => {
    vi.stubEnv("EXPO_PUBLIC_CINDY_DIAGNOSTICS", "");
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    expect(log.diagnosticsEnabled()).toBe(false);
  });
  it("prunes expired and future records before persisting and exporting", async () => {
    const now = Date.now();
    storage.getItem.mockResolvedValue(
      JSON.stringify({
        events: [
          { at: now - 8 * 86400_000, event: "app started" },
          { at: now + 86400_000, event: "app started" },
          { at: now, event: "app active" },
        ],
      }),
    );
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    expect(await log.diagnosticSnapshot()).toEqual([
      { at: now, event: "app active", fields: {} },
    ]);
    await log.flushDiagnostics();
    expect(
      JSON.parse(storage.setItem.mock.calls.at(-1)![1]).events,
    ).toHaveLength(1);
  });
  it("does not enable a corrupt opt-out record", async () => {
    storage.getItem.mockResolvedValue('{"enabled":"false"}');
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    expect(log.diagnosticsEnabled()).toBe(false);
  });
  it("does not record before hydration and bounds persisted events", async () => {
    const log = await import("./localDiagnostics");
    log.recordDiagnostic("relay connection error", "private");
    await log.hydrateDiagnostics();
    for (let i = 0; i < 700; i++) log.recordDiagnostic("app active");
    await log.flushDiagnostics();
    const saved = JSON.parse(storage.setItem.mock.calls.at(-1)![1]);
    expect(saved.events).toHaveLength(500);
    expect(saved.enabled).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("private");
  });
  it("retains an explicit opt-out across launches", async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({ enabled: false, events: [] }),
    );
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    log.recordDiagnostic("app started");
    await log.flushDiagnostics();
    expect(log.diagnosticsEnabled()).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("fails closed on an unreadable store", async () => {
    storage.getItem.mockRejectedValue(new Error("unavailable"));
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    expect(log.diagnosticsEnabled()).toBe(false);
  });
  it("orders clear after an older in-flight save", async () => {
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    let release!: () => void;
    storage.setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    log.recordDiagnostic("app started");
    const first = log.flushDiagnostics();
    await Promise.resolve();
    const cleared = log.clearDiagnostics();
    release();
    await Promise.all([first, cleared]);
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).events).toEqual(
      [],
    );
  });
  it("reports failed writes and retries on the next flush", async () => {
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));
    log.recordDiagnostic("app started");
    await expect(log.flushDiagnostics()).rejects.toThrow("disk full");
    await log.flushDiagnostics();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });
});
