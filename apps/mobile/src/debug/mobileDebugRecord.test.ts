import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mobileDebugEnabled,
  mobileDebugLog,
  setMobileDebugSink,
} from "./mobileDebugLog";
import { serializeMobileDebugRecord } from "./mobileDebugRecord";

afterEach(() => setMobileDebugSink(undefined));
describe("detailed phone debug records", () => {
  it("does no work while disabled and never propagates sink failures", () => {
    const sink = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(mobileDebugEnabled()).toBe(false);
    mobileDebugLog("debug", "scroll", "position", { offsetY: 12 });
    expect(sink).not.toHaveBeenCalled();
    setMobileDebugSink(sink);
    expect(() => mobileDebugLog("debug", "scroll", "position")).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
  });
  it("retains request timing, error message, stack and cause without credentials or bodies", () => {
    const cause = new Error("socket timed out");
    const error = new Error("connection failed Bearer very-secret", { cause });
    Object.assign(error, {
      code: "ETIMEDOUT",
      headers: { Authorization: "hidden" },
      body: "private conversation",
    });
    const line = serializeMobileDebugRecord(
      "error",
      "device-link",
      ["request failed elapsed=120ms", error],
      123,
    );
    const result = JSON.parse(line);
    expect(result).toMatchObject({
      at: 123,
      level: "error",
      scope: "device-link",
    });
    expect(result.args[1]).toMatchObject({
      code: "ETIMEDOUT",
      message: "connection failed Bearer [redacted]",
      cause: { message: "socket timed out" },
    });
    expect(result.args[1].stack).toContain("connection failed");
    expect(line).not.toMatch(/very-secret|hidden|private conversation/);
  });
  it("filters nested content, string credentials and URL paths; escapes forged record boundaries", () => {
    const line = serializeMobileDebugRecord("debug", "recovery", [
      'stage\n{"level":"error"}',
      {
        nested: { token: "secret1", prompt: "secret2", message: "secret3" },
        error:
          'https://user:pass@example.org/private?token=secret4 bearer secret5 x-api-key="secret6"',
        elapsedMs: 123,
      },
    ]);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(line).not.toMatch(/secret[1-6]|user:pass|\/private/);
    expect(JSON.parse(line).args[1].elapsedMs).toBe(123);
  });
  it("bounds cyclic data and avoids getters/toJSON", () => {
    const getter = vi.fn(() => "private");
    const value: Record<string, unknown> = { toJSON: getter };
    Object.defineProperty(value, "hostile", { get: getter, enumerable: true });
    value.self = value;
    value.items = Array.from({ length: 100 }, () => "x".repeat(10_000));
    const line = serializeMobileDebugRecord("debug", "performance", [
      "snapshot",
      value,
    ]);
    expect(line.length).toBeLessThanOrEqual(16_001);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
