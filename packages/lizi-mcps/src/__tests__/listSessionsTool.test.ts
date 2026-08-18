import { describe, expect, it, vi } from "vitest";

import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { XdtHelperHistoryDeps } from "../xdt-helper/_history_types.js";
import { registerListSessionsTool } from "../xdt-helper/list_sessions.js";
import type { SessionQueueDeps } from "../xdt-helper/list_session_queue.js";

function parse(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text" || !first.text)
    throw new Error("missing text payload");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function historyWithSessions(): XdtHelperHistoryDeps {
  return {
    listWorkdirs: vi.fn(),
    listSessions: vi.fn(async () => ({
      ok: true as const,
      page: {
        items: [
          {
            id: "session-1",
            title: "Busy",
            workingDir: "/repo",
            agentKind: "codex",
            workspaceKind: "project",
            model: "gpt-5.6",
            status: "active",
            source: "desktop",
            orcaRole: null,
            parentSessionId: null,
            createdAt: 1,
            updatedAt: 2,
            userSendAt: null,
            messageCount: 3,
          },
          {
            id: "session-2",
            title: "Idle",
            workingDir: "/repo",
            agentKind: "cc",
            workspaceKind: "project",
            model: "claude",
            status: "active",
            source: "desktop",
            orcaRole: null,
            parentSessionId: null,
            createdAt: 3,
            updatedAt: 4,
            userSendAt: null,
            messageCount: 1,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    })),
    getMessages: vi.fn(),
    searchChatHistory: vi.fn(),
  };
}

describe("list_sessions queuedCount", () => {
  it("adds live queuedCount values for the returned page", async () => {
    const sessionQueue: SessionQueueDeps = {
      listSessionQueue: vi.fn(),
      listSessionQueuedCounts: vi.fn(async () => ({
        ok: true as const,
        counts: { "session-1": 2 },
      })),
    };
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, {
      history: historyWithSessions(),
      sessionQueue,
    });

    const payload = parse(await registry.call("list_sessions", {}));

    expect(payload).toMatchObject({
      ok: true,
      sessions: [
        { id: "session-1", messageCount: 3, queuedCount: 2 },
        { id: "session-2", messageCount: 1, queuedCount: 0 },
      ],
    });
    expect(sessionQueue.listSessionQueuedCounts).toHaveBeenCalledWith([
      "session-1",
      "session-2",
    ]);
  });

  it("fails instead of reporting stale zeroes when queue restoration fails", async () => {
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, {
      history: historyWithSessions(),
      sessionQueue: {
        listSessionQueue: vi.fn(),
        listSessionQueuedCounts: vi.fn(async () => ({
          ok: false as const,
          errorCode: "INTERNAL" as const,
          message: "snapshot unavailable",
        })),
      },
    });

    expect(parse(await registry.call("list_sessions", {}))).toMatchObject({
      ok: false,
      errorCode: "INTERNAL",
      data: { hint: "snapshot unavailable" },
    });
  });
});
