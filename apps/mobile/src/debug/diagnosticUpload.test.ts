import { describe, expect, it, vi } from "vitest";
import {
  parseDiagnosticUploadTarget,
  uploadDiagnosticSnapshot,
  type DiagnosticUploadDeps,
} from "./diagnosticUpload";

const target = {
  region: "global",
  project: "test-global",
  logstore: "test-mobile",
  endpointHost: "ap-southeast-1.log.aliyuncs.com",
};
function deps(): DiagnosticUploadDeps {
  return {
    rawTarget: JSON.stringify(target),
    region: "global",
    consent: vi.fn(async () => true),
    snapshot: vi.fn(async () => [
      { at: Date.now(), event: "app started", fields: { token: "secret" } },
    ]),
    randomBytes: () => new Uint8Array(16),
    fetch: vi.fn(async () => new Response("", { status: 200 })),
    appVersion: "测试",
    platform: "ios",
    osVersion: "27",
  };
}
describe("manual mobile diagnostic upload", () => {
  it("uses desktop wire format and byte counts without credentials or unknown fields", async () => {
    const d = deps();
    expect(await uploadDiagnosticSnapshot(d)).toEqual({
      kind: "uploaded",
      uploadCode: "2222-2222",
      count: 1,
    });
    const [url, init] = vi.mocked(d.fetch).mock.calls[0];
    expect(url).toBe(
      "https://test-global.ap-southeast-1.log.aliyuncs.com/logstores/test-mobile/track",
    );
    expect(init.headers).toMatchObject({
      "x-log-apiversion": "0.6.0",
      "x-log-bodyrawsize": String(
        new TextEncoder().encode(String(init.body)).byteLength,
      ),
    });
    expect(String(init.body)).not.toMatch(/secret|token|Authorization/);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body)).__logs__[0].uploadCode).toBe(
      "2222-2222",
    );
  });
  it.each([
    "",
    JSON.stringify({ ...target, region: "cn" }),
    JSON.stringify({ ...target, project: "evil.com" }),
    JSON.stringify({ ...target, endpointHost: "evil.com" }),
  ])(
    "rejects absent or invalid routing before any collection: %s",
    async (raw) => {
      const d = { ...deps(), rawTarget: raw };
      expect(parseDiagnosticUploadTarget(raw, "global")).toBeNull();
      expect(await uploadDiagnosticSnapshot(d)).toEqual({
        kind: "unavailable",
      });
      expect(d.snapshot).not.toHaveBeenCalled();
      expect(d.fetch).not.toHaveBeenCalled();
    },
  );
  it("requires consent even when the user manually asks to upload", async () => {
    const d = deps();
    vi.mocked(d.consent).mockResolvedValue(false);
    expect(await uploadDiagnosticSnapshot(d)).toEqual({
      kind: "consentRequired",
    });
    expect(d.snapshot).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("rechecks consent after asynchronous collection", async () => {
    const d = deps();
    vi.mocked(d.consent).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await uploadDiagnosticSnapshot(d)).toEqual({
      kind: "consentRequired",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("does not upload empty or invalid records", async () => {
    const d = deps();
    vi.mocked(d.snapshot).mockResolvedValue([{ at: 1, event: "unknown body" }]);
    expect(await uploadDiagnosticSnapshot(d)).toEqual({ kind: "empty" });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("treats server errors as failure without retries", async () => {
    const d = deps();
    vi.mocked(d.fetch).mockResolvedValue(new Response("", { status: 503 }));
    expect(await uploadDiagnosticSnapshot(d)).toEqual({ kind: "failed" });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled network request", async () => {
    vi.useFakeTimers();
    try {
      const d = deps();
      vi.mocked(d.fetch).mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      const result = uploadDiagnosticSnapshot(d);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await result).toEqual({ kind: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
