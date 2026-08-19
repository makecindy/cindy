import { describe, expect, it, vi } from "vitest";

import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import {
  registerListSessionQueueTool,
  type SessionQueueDeps,
} from "../xdt-helper/list_session_queue.js";

function parse(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text" || !first.text)
    throw new Error("missing text payload");
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("list_session_queue", () => {
  it("returns ordered queue metadata with bounded content summaries", async () => {
    const longContent = ` first\nmessage ${"界".repeat(510)}`;
    const deps: SessionQueueDeps = {
      listSessionQueue: vi.fn(async () => ({
        ok: true as const,
        messages: [
          {
            queuedMessageId: "q-1",
            position: 0,
            source: "orca" as const,
            sourceLabel: "Lead",
            enqueuedAtMs: Date.parse("2026-08-16T01:02:03.000Z"),
            content: longContent,
            consuming: true,
          },
          {
            queuedMessageId: "q-2",
            position: 1,
            source: "user" as const,
            sourceLabel: null,
            enqueuedAtMs: null,
            content: "follow up",
            consuming: false,
          },
          {
            queuedMessageId: "q-3",
            position: 2,
            source: "session" as const,
            sourceLabel: "sender-session",
            enqueuedAtMs: Date.parse("2026-08-16T01:02:04.000Z"),
            content: "cross-session follow up",
            consuming: false,
          },
        ],
      })),
      listSessionQueuedCounts: vi.fn(),
    };
    const registry = new XdtHelperToolRegistry();
    registerListSessionQueueTool(registry, deps);

    const payload = parse(
      await registry.call("list_session_queue", { session_id: "session-1" }),
    );

    expect(payload).toMatchObject({
      ok: true,
      session_id: "session-1",
      queued_count: 3,
      queue: [
        {
          queued_message_id: "q-1",
          position: 0,
          source: "orca",
          source_label: "Lead",
          enqueued_at: "2026-08-16T01:02:03.000Z",
          truncated: true,
          consuming: true,
        },
        {
          queued_message_id: "q-2",
          position: 1,
          source: "user",
          enqueued_at: null,
          content_summary: "follow up",
          truncated: false,
          consuming: false,
        },
        {
          queued_message_id: "q-3",
          position: 2,
          source: "session",
          source_label: "sender-session",
          enqueued_at: "2026-08-16T01:02:04.000Z",
          content_summary: "cross-session follow up",
          truncated: false,
          consuming: false,
        },
      ],
    });
    const queue = payload.queue as Array<Record<string, unknown>>;
    expect(Array.from(String(queue[0]?.content_summary)).length).toBe(501);
    expect(queue[1]).not.toHaveProperty("source_label");
    expect(deps.listSessionQueue).toHaveBeenCalledWith("session-1");
  });

  it("maps missing sessions and host failures to stable errors", async () => {
    const listSessionQueue = vi
      .fn<SessionQueueDeps["listSessionQueue"]>()
      .mockResolvedValueOnce({
        ok: false as const,
        errorCode: "NOT_FOUND" as const,
        message: "missing",
      })
      .mockResolvedValueOnce({
        ok: false as const,
        errorCode: "HOST_NOT_READY" as const,
        message: "booting",
      })
      .mockResolvedValueOnce({
        ok: false as const,
        errorCode: "INTERNAL" as const,
        message: "restore failed",
      });
    const registry = new XdtHelperToolRegistry();
    registerListSessionQueueTool(registry, {
      listSessionQueue,
      listSessionQueuedCounts: vi.fn(),
    });

    expect(
      parse(await registry.call("list_session_queue", { session_id: "gone" })),
    ).toMatchObject({
      ok: false,
      errorCode: "NOT_FOUND",
    });
    expect(
      parse(
        await registry.call("list_session_queue", { session_id: "booting" }),
      ),
    ).toMatchObject({
      ok: false,
      errorCode: "HOST_NOT_READY",
    });
    expect(
      parse(
        await registry.call("list_session_queue", { session_id: "broken" }),
      ),
    ).toMatchObject({
      ok: false,
      errorCode: "INTERNAL",
      data: { hint: "restore failed" },
    });
  });
});
