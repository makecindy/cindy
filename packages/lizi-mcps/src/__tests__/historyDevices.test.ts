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
