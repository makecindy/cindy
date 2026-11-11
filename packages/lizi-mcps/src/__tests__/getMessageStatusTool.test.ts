import { describe, expect, it, vi } from "vitest";

import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import {
  registerGetMessageStatusTool,
  type MessageStatusDeps,
} from "../xdt-helper/get_message_status.js";

function parse(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text" || !first.text)
    throw new Error("missing text payload");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function makeRegistry(deps: MessageStatusDeps): XdtHelperToolRegistry {
  const registry = new XdtHelperToolRegistry();
  registerGetMessageStatusTool(registry, deps);
  return registry;
}

describe("get_message_status", () => {
  it("passes session/message ids through and returns the host snapshot", async () => {
    const getMessageStatus = vi.fn(async () => ({
      ok: true as const,
      status: "queued" as const,
      position: 2,
      source: "session" as const,
      source_label: "sender-session",
      enqueued_at: "2026-08-16T01:02:03.000Z",
    }));
    const registry = makeRegistry({ getMessageStatus });

    const payload = parse(
      await registry.call("get_message_status", {
        session_id: "device-a::session-1",
        message_id: "queued-1",
      }),
    );

    expect(payload).toMatchObject({
      ok: true,
      session_id: "device-a::session-1",
      message_id: "queued-1",
      status: "queued",
      position: 2,
      source: "session",
      source_label: "sender-session",
      enqueued_at: "2026-08-16T01:02:03.000Z",
    });
    expect(getMessageStatus).toHaveBeenCalledWith({
      sessionId: "device-a::session-1",
      messageId: "queued-1",
    });
  });

  it("returns consumed status with consumed_at", async () => {
    const registry = makeRegistry({
      getMessageStatus: vi.fn(async () => ({
        ok: true as const,
        status: "consumed" as const,
        consumed_at: "2026-08-16T01:05:00.000Z",
      })),
    });

    const payload = parse(
      await registry.call("get_message_status", {
        session_id: "session-1",
        message_id: "m-1",
      }),
    );

    expect(payload).toMatchObject({
      ok: true,
      status: "consumed",
      consumed_at: "2026-08-16T01:05:00.000Z",
    });
  });

  it("maps NOT_FOUND to a stable error without the remote suffix", async () => {
    const registry = makeRegistry({
      getMessageStatus: vi.fn(async () => ({
        ok: false as const,
        errorCode: "NOT_FOUND" as const,
        message: "message m-1 not found in session session-1",
      })),
    });

    const payload = parse(
      await registry.call("get_message_status", {
        session_id: "session-1",
        message_id: "m-1",
      }),
    );

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe("NOT_FOUND");
    expect(String((payload.data as { hint: string }).hint)).not.toContain(
      "结果不完整",
    );
  });

  it("marks REMOTE_* failures as incomplete results", async () => {
    const registry = makeRegistry({
      getMessageStatus: vi.fn(async () => ({
        ok: false as const,
        errorCode: "REMOTE_DEVICE_OFFLINE" as const,
        message: "device device-a is offline",
      })),
    });

    const payload = parse(
      await registry.call("get_message_status", {
        session_id: "device-a::session-1",
        message_id: "m-1",
      }),
    );

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe("REMOTE_DEVICE_OFFLINE");
    expect(String((payload.data as { hint: string }).hint)).toContain(
      "结果不完整",
    );
  });

  it("rejects an unknown host status as INTERNAL", async () => {
    const registry = makeRegistry({
      getMessageStatus: vi.fn(
        async () =>
          ({
            ok: true as const,
            status: "mystery" as never,
          }) as never,
      ),
    });

    const payload = parse(
      await registry.call("get_message_status", {
        session_id: "session-1",
        message_id: "m-1",
      }),
    );

    expect(payload).toMatchObject({ ok: false, errorCode: "INTERNAL" });
  });
});
