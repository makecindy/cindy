import { describe, expect, it } from "vitest";

import { IOSSimulatorDiagnosticsStore } from "./diagnostics-store.js";

describe("IOSSimulatorDiagnosticsStore", () => {
  it("isolates entries by session and expires them", () => {
    let now = 1_000;
    const store = new IOSSimulatorDiagnosticsStore({
      now: () => now,
      ttlMs: 100,
    });
    const entry = store.record("session-a", "capture_state", { ready: true });
    expect(store.get("session-b", entry.diagnosticsId)).toBeNull();
    expect(store.get("session-a", entry.diagnosticsId)).toMatchObject({
      data: { ready: true },
    });
    now = 1_101;
    expect(store.get("session-a", entry.diagnosticsId)).toBeNull();
  });

  it("caps retained entry count and oversized JSON", () => {
    const store = new IOSSimulatorDiagnosticsStore({
      maxEntries: 1,
      maxJsonBytes: 32,
    });
    const first = store.record("session-a", "first", { value: 1 });
    const second = store.record("session-a", "second", {
      value: "x".repeat(100),
    });
    expect(store.get("session-a", first.diagnosticsId)).toBeNull();
    expect(store.get("session-a", second.diagnosticsId)?.data).toMatchObject({
      truncated: true,
    });
  });
});
