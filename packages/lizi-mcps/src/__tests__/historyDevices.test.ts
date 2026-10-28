import { describe, expect, it, vi } from "vitest";
import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { registerListSessionsTool } from "../xdt-helper/list_sessions.js";
import { registerSearchChatHistoryTool } from "../xdt-helper/search_chat_history.js";
import { registerGetChatHistoryTool } from "../xdt-helper/get_chat_history.js";
import {
  historyPayload,
  registerHistoryDevicesTool,
} from "../xdt-helper/_history_devices.js";
import type { XdtHelperHistoryDeps } from "../xdt-helper/_history_types.js";

function setup() {
  const registry = new XdtHelperToolRegistry();
  const remoteQuery = vi.fn(async () => ({
    ok: true,
    sessions: [{ id: "same", title: "Remote", parentSessionId: "parent" }],
    hasMore: true,
    nextCursor: "remote-cursor",
  }));
  const listDevices = vi.fn(async () => [
    {
      deviceId: "local",
      deviceName: "This computer",
      local: true,
      available: true,
    },
    {
      deviceId: "mac",
      deviceName: "Other computer",
      local: false,
      available: true,
    },
    {
      deviceId: "offline",
      deviceName: "Sleeping",
      local: false,
      available: false,
      unavailableReason: "REMOTE_DEVICE_OFFLINE",
    },
  ]);
  const history: XdtHelperHistoryDeps = {
    listWorkdirs: vi.fn(),
    getMessages: vi.fn(async () => ({
      ok: true as const,
      page: { items: [], nextCursor: null, hasMore: false },
    })),
    listSessions: vi.fn(async () => ({
      ok: true as const,
      page: {
        items: [
          {
            id: "same",
            title: "Local",
            workingDir: null,
            agentKind: "codex",
            workspaceKind: "chat",
            model: "model",
            status: "active",
            source: "desktop",
            orcaRole: null,
            parentSessionId: null,
            createdAt: 1,
            updatedAt: 2,
            userSendAt: null,
            messageCount: 1,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    })),
    searchChatHistory: vi.fn(async () => ({
      ok: true as const,
      result: {
        hits: [],
        sessions: {},
        vectorUsed: false,
        vectorSkipReason: "disabled",
        nextOffset: null,
        hasMore: false,
        poolSize: 0,
        poolCapped: false,
      },
    })),
    remote: { listDevices, query: remoteQuery, captureAccess: () => () => {} },
  };
  registerListSessionsTool(registry, { history });
  registerSearchChatHistoryTool(registry, { history });
  registerHistoryDevicesTool(registry, { history });
  registerGetChatHistoryTool(registry, { history });
  return {
    registry,
    history,
    remoteQuery,
    listDevices,
    call: async (name: string, args = {}) =>
      historyPayload(await registry.call(name, args)) as any,
  };
}

describe("history device discovery and queries", () => {
  // Regression: callers could find a task but had no clickable link to return,
  // especially when the same id appeared on different computers or an older host.
  it("returns host-built links for local and older remote results without changing tool ids", async () => {
    const s = setup();
    const localUrl = "cindy://session/same?device=host";
    const remoteUrl = "cindy://session/same?device=mac";
    s.history.sessionUrl = vi.fn((id) => {
      if (id === "same") return localUrl;
      if (id === "mac::same") return remoteUrl;
      throw new Error(`Unexpected session key: ${id}`);
    });
    const list = await s.call("list_sessions", { device: "all" });
    expect(list.groups[0].sessions[0]).toMatchObject({ id: "same", sessionUrl: localUrl });
    expect(list.groups[1].sessions[0]).toMatchObject({ id: "mac::same", sessionUrl: remoteUrl });

    const meta = { title: "Task", workingDir: null, agentKind: "codex" };
    vi.mocked(s.history.searchChatHistory).mockResolvedValueOnce({ ok: true, result: {
      hits: [], sessions: { same: meta }, vectorUsed: false, vectorSkipReason: null,
      nextOffset: null, hasMore: false, poolSize: 0, poolCapped: false,
    } });
    expect((await s.call("search_chat_history", { query: "task" })).sessions.same)
      .toMatchObject({ ...meta, sessionUrl: localUrl });
    s.remoteQuery.mockResolvedValueOnce({ ok: true, hits: [], sessions: { same: meta } } as any);
    expect((await s.call("search_chat_history", { device: "mac", query: "task" })).groups[0].sessions["mac::same"])
      .toMatchObject({ ...meta, sessionUrl: remoteUrl });

    for (const [id, sessionUrl] of [["same", localUrl], ["mac::same", remoteUrl]]) {
      vi.mocked(s.history.getMessages).mockResolvedValueOnce({ ok: true, page: {
        items: [{ id: "m", sessionId: id!, sessionTitle: "Task", sessionWorkingDir: null,
          sessionAgentKind: "codex", role: "assistant", content: "Done", createdAt: 1,
          toolUseId: null, agentMeta: null, rewindAt: null }], nextCursor: null, hasMore: false,
      } });
      const result = await s.call("get_chat_history", { session_ids: [id] });
      expect(result.sessions[id!]).toMatchObject({ sessionUrl });
      expect(result.messages[0]).toMatchObject({ sessionId: id, content: "Done" });
    }
  });

  // The execution-device Worker has no local orcaRole. Keep its persisted origin
  // visible through the real list_sessions projection so it can identify its Lead.
  it("projects remote Worker origin while leaving local role and Fork fields absent", async () => {
    const s = setup();
    const base = await s.history.listSessions({ sessionIds: null, workdir: null, fromMs: null, toMs: null,
      agentKind: null, includeDeleted: false, limit: 1, cursor: null, order: "desc" });
    if (!base.ok) throw new Error("fixture unavailable");
    const lead = { leadDeviceId: "pc", leadDeviceName: "PC", leadSessionId: "lead-1", leadTitle: "Lead", workerLabel: "tester" };
    vi.mocked(s.history.listSessions).mockResolvedValueOnce({ ...base,
      page: { ...base.page, items: [{ ...base.page.items[0]!, orcaRemoteLead: lead }] } });
    const result = await s.call("list_sessions");
    expect(result.sessions[0]).toMatchObject({ orcaRemoteLead: lead });
    expect(result.sessions[0]).not.toHaveProperty("orcaRole");
    expect(result.sessions[0]).not.toHaveProperty("parentSessionId");
  });

  it("keeps legacy local queries local and preserves their response", async () => {
    const s = setup();
    expect(await s.call("list_sessions")).toMatchObject({
      ok: true,
      sessions: [{ id: "same" }],
      hasMore: false,
    });
    expect(s.listDevices).not.toHaveBeenCalled();
  });
  it("groups devices, qualifies identities and reports skipped offline computers", async () => {
    const s = setup();
    const result = await s.call("list_sessions", { device: "all", limit: 2 });
    expect(result).toMatchObject({
      partial: true,
      hasMore: true,
      groups: [
        { deviceId: "local", sessions: [{ id: "same" }] },
        {
          deviceId: "mac",
          sessions: [{ id: "mac::same", parentSessionId: "mac::parent" }],
          nextCursor: "remote-cursor",
        },
        { deviceId: "offline", ok: false, errorCode: "REMOTE_DEVICE_OFFLINE" },
      ],
    });
    expect(s.remoteQuery).toHaveBeenCalledTimes(1);
    await s.call("list_sessions", {
      device: "mac",
      cursor: result.groups[1].nextCursor,
    });
    expect(s.remoteQuery).toHaveBeenLastCalledWith(
      "mac",
      "list_sessions",
      expect.objectContaining({ device: "local", cursor: "remote-cursor" }),
    );
  });
  // Optional filters survive forwarding; an old schema failure must never retry unscoped.
  it("forwards teammate filters and reports an old schema rejection without dropping them", async () => {
    const s = setup();
    s.remoteQuery.mockResolvedValueOnce({ ok: false, errorCode: "INVALID_ARGS", message: "Unrecognized key: teammate_id" } as any);
    const result = await s.call("list_sessions", {
      device: "all", teammate_id: "bot-a", source: "bot", time_field: "activity",
    });
    expect(s.history.listSessions).toHaveBeenCalledWith(expect.objectContaining({ teammateId: "bot-a", source: "bot", timeField: "activity" }));
    expect(s.remoteQuery).toHaveBeenCalledExactlyOnceWith("mac", "list_sessions", expect.objectContaining({
      device: "local", teammate_id: "bot-a", source: "bot", time_field: "activity",
    }));
    expect(result).toMatchObject({ partial: true, groups: expect.arrayContaining([
      expect.objectContaining({ deviceId: "mac", ok: false, errorCode: "INVALID_ARGS" }),
    ]) });
    await s.call("search_chat_history", { device: "mac", query: "topic", teammate_id: "bot-a", source: "bot" });
    expect(s.remoteQuery).toHaveBeenLastCalledWith("mac", "search_chat_history", expect.objectContaining({ teammate_id: "bot-a", source: "bot" }));
  });
  it("qualifies search hits, metadata and context and supports reading the returned identity", async () => {
    const s = setup();
    s.remoteQuery.mockResolvedValueOnce({
      ok: true,
      hits: [
        {
          messageId: "m",
          sessionId: "same",
          context: [{ id: "m", sessionId: "same", content: "found" }],
        },
      ],
      sessions: { same: { title: "Remote" } },
      nextCursor: null,
      hasMore: false,
    } as any);
    const result = await s.call("search_chat_history", {
      device: "mac",
      query: "find",
      session_ids: ["mac::same"],
    });
    expect(s.remoteQuery).toHaveBeenCalledWith(
      "mac",
      "search_chat_history",
      expect.objectContaining({ session_ids: ["same"] }),
    );
    expect(result.groups[0]).toMatchObject({
      sessions: { "mac::same": { title: "Remote" } },
      hits: [{ sessionId: "mac::same", context: [{ sessionId: "mac::same" }] }],
    });
    await s.call("get_chat_history", {
      session_ids: [result.groups[0].hits[0].sessionId],
    });
    expect(s.history.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ["mac::same"] }),
    );
  });
  it("does not widen Bot scope, including denied/missing ownership", async () => {
    const s = setup();
    s.history.resolveSessionScope = async () => ({ ok: true, sessionIds: [] });
    for (const name of [
      "list_history_devices",
      "list_sessions",
      "search_chat_history",
    ]) {
      expect(
        await s.call(
          name,
          name === "list_history_devices"
            ? {}
            : {
                device: "all",
                ...(name === "search_chat_history" ? { query: "x" } : {}),
              },
        ),
      ).toMatchObject({ ok: false, errorCode: "HISTORY_SCOPE_DENIED" });
    }
    expect(s.listDevices).not.toHaveBeenCalled();
    expect(s.remoteQuery).not.toHaveBeenCalled();
  });
  it("keeps local results when discovery fails and isolates remote query failures", async () => {
    const s = setup();
    s.listDevices.mockRejectedValueOnce(new Error("offline"));
    expect(await s.call("list_sessions", { device: "all" })).toMatchObject({
      partial: true,
      discoveryError: "DEVICE_DISCOVERY_FAILED",
      groups: [{ sessions: [{ id: "same" }] }],
    });
    s.remoteQuery.mockRejectedValueOnce(new Error("timeout"));
    expect(await s.call("list_sessions", { device: "all" })).toMatchObject({
      partial: true,
      groups: [
        { ok: true },
        { ok: false, errorCode: "REMOTE_UNAVAILABLE" },
        { ok: false },
      ],
    });
  });
  it("rejects ambiguous cursors, device IDs and mixed session identity routes", async () => {
    const s = setup();
    expect(
      await s.call("list_sessions", { device: "all", cursor: "cursor" }),
    ).toMatchObject({ ok: false, errorCode: "INVALID_ARGS" });
    expect(await s.call("list_sessions", { device: "unknown" })).toMatchObject({
      ok: false,
      errorCode: "NOT_FOUND",
    });
    for (const args of [
      { device: "local", session_ids: ["mac::same"] },
      { device: "mac", session_ids: ["other::same"] },
      { device: "all", session_ids: ["mac::same"] },
    ]) {
      expect(
        await s.call("search_chat_history", { query: "x", ...args }),
      ).toMatchObject({ ok: false, errorCode: "INVALID_ARGS" });
    }
    expect(s.remoteQuery).not.toHaveBeenCalled();
  });
  it("discards all results if the owner changes during a query", async () => {
    const s = setup();
    let current = true;
    s.history.remote!.captureAccess = () => () => {
      if (!current) throw new Error("Owner changed");
    };
    s.remoteQuery.mockImplementationOnce(async () => {
      current = false;
      return {
        ok: true,
        sessions: [],
        hasMore: false,
        nextCursor: null,
      } as any;
    });
    await expect(s.call("list_sessions", { device: "all" })).rejects.toThrow(
      "Owner changed",
    );
  });
});
