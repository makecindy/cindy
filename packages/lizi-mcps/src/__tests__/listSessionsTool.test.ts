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

describe("list_sessions agent_kind", () => {
  it("passes the pi filter through registry validation to the host", async () => {
    const history = historyWithSessions();
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, { history });

    expect(registry.get("list_sessions")?.description).toContain(
      "agent_kind: cc(Claude Code) | codex | pi",
    );
    const result = await registry.call("list_sessions", { agent_kind: "pi" });

    expect(parse(result)).toMatchObject({ ok: true });
    expect(history.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: "pi" }),
    );
  });
});

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

// Plugin boards align their columns with the sidebar inbox: the owning computer classifies each
// row with the shared taskInboxSection, so a board never re-derives the rules. Unit tier.
describe("list_sessions include_inbox", () => {
  const now = Date.now();
  function historyWithInbox(): XdtHelperHistoryDeps {
    const history = historyWithSessions();
    const row = (id: string, extra: Record<string, unknown>) => ({
      id, title: id, workingDir: "/repo", agentKind: "cc", workspaceKind: "project", model: "m",
      status: "active", source: "desktop", orcaRole: null, parentSessionId: null,
      createdAt: 1, updatedAt: 2, userSendAt: null, messageCount: 1, ...extra,
    });
    history.listSessions = vi.fn(async () => ({
      ok: true as const,
      page: {
        items: [
          row("snoozed", { snoozedUntil: now + 3_600_000, snoozedAt: now - 1_000 }),
          // A new input after the snooze wakes the task even before the wake time.
          row("woken", { snoozedUntil: now + 3_600_000, snoozedAt: now - 2_000, userSendAt: now - 1_000 }),
          row("followed", {}),
          row("followed-unread", {}),
          row("archived", { status: "archived" }),
          row("deleted", { status: "deleted" }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    }));
    history.readTaskInbox = vi.fn(async () => ({
      ok: true as const,
      signals: {
        snoozed: { waiting: true, running: false, unread: false, following: false },
        woken: { waiting: false, running: true, unread: false, following: false },
        followed: { waiting: false, running: false, unread: false, following: true },
        "followed-unread": { waiting: false, running: false, unread: true, following: true },
      },
    }));
    return history;
  }

  it("classifies each row with the sidebar's sections and keeps the snooze pair", async () => {
    const history = historyWithInbox();
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, { history });

    const payload = parse(await registry.call("list_sessions", { include_inbox: true })) as {
      sessions: Array<{ id: string; snoozedUntil?: string; inbox: { section: string | null; following: boolean } }>;
    };
    const sections = Object.fromEntries(payload.sessions.map((s) => [s.id, s.inbox.section]));
    expect(sections).toEqual({
      snoozed: "snoozed",
      woken: "working",
      followed: "working",
      "followed-unread": "inbox",
      archived: "archived",
      deleted: null,
    });
    expect(payload.sessions[0]?.snoozedUntil).toBe(new Date(now + 3_600_000).toISOString());
    expect(history.readTaskInbox).toHaveBeenCalledWith(
      ["snoozed", "woken", "followed", "followed-unread", "archived", "deleted"],
    );
  });

  it("does not read live signals unless asked, and reports hosts that cannot classify", async () => {
    const history = historyWithInbox();
    const registry = new XdtHelperToolRegistry();
    registerListSessionsTool(registry, { history });
    const plain = parse(await registry.call("list_sessions", {})) as { sessions: Array<Record<string, unknown>> };
    expect(plain.sessions[0]).not.toHaveProperty("inbox");
    expect(plain.sessions[0]).toHaveProperty("snoozedAt");
    expect(history.readTaskInbox).not.toHaveBeenCalled();

    const legacy = new XdtHelperToolRegistry();
    registerListSessionsTool(legacy, { history: { ...history, readTaskInbox: undefined } });
    expect(parse(await legacy.call("list_sessions", { include_inbox: true }))).toMatchObject({
      ok: false, errorCode: "UNSUPPORTED_CAPABILITY",
    });
  });
});
