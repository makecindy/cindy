import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
const files = vi.hoisted(() => ({
  write: vi.fn(),
  remove: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
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
vi.mock("react-native", () => ({ AppState: {} }));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_CINDY_DIAGNOSTICS", "1");
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
  files.write.mockReset();
  files.remove.mockReset();
  files.share.mockReset().mockResolvedValue(undefined);
  files.available.mockReset().mockResolvedValue(true);
});
describe("local journal persistence", () => {
  it("restores the build default by deleting the override without clearing logs", async () => {
    const log = await import("./localDiagnostics");
    await log.hydrateDiagnostics();
    log.recordDiagnostic("app active");
    await log.setDiagnosticsEnabled(false);
    await log.resetDiagnosticsEnabled();
    expect(log.diagnosticsEnabled()).toBe(true);
    const saved = JSON.parse(storage.setItem.mock.calls.at(-1)![1]);
    expect(saved).not.toHaveProperty("enabled");
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
      expect(files.write.mock.calls[0][0]).not.toMatch(/private|token/);
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
