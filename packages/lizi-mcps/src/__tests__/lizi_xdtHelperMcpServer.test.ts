import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const TARGET_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function parsePayload(result: unknown): Record<string, unknown> {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || !first.text) {
    throw new Error("tool result has no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("cindy_helper MCP server", () => {
  it("dispatches a discovered send_to_session call without dropping nested arguments", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Issue follow-up",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      { sendToSession },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-transport-test",
      version: "0.0.0",
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const topLevelTools = await client.listTools();
      expect(topLevelTools.tools.map((tool) => tool.name).sort()).toEqual([
        "call_tool",
        "list_tools",
      ]);

      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "handoff" },
        }),
      );
      expect(discovered).toMatchObject({
        ok: true,
        category: "handoff",
      });
      const discoveredTools = discovered.tools as Array<{ name: string }>;
      expect(discoveredTools.map((tool) => tool.name)).toContain(
        "send_to_session",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "send_to_session",
          args: {
            target_session_id: TARGET_SESSION_ID,
            message: "Continue the existing task",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({
        ok: true,
        target_session_id: TARGET_SESSION_ID,
        wake_kind: "resumed",
      });
      expect(sendToSession).toHaveBeenCalledOnce();
      expect(sendToSession).toHaveBeenCalledWith({
        targetSessionId: TARGET_SESSION_ID,
        message: "Continue the existing task",
        dispatcherSessionId: "dispatcher-session",
        title: undefined,
        useWorktree: undefined,
        workingDir: undefined,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes Bot delegation through live discovery for a Bot-bound session", async () => {
    const listBots = vi.fn(async () => ({
      ok: true as const,
      bots: [{ id: "bot-b", name: "Dash Bot" }],
    }));
    const delegateToBot = vi.fn(async () => ({
      ok: true as const,
      delegationId: "delegation-1",
      childSessionId: "bot-child-session",
      status: "running",
    }));
    const listDelegations = vi.fn(async () => ({ ok: true as const, delegations: [] }));
    const cancelDelegation = vi.fn(async () => ({
      ok: true as const,
      delegationId: "delegation-1",
      childSessionId: "bot-child-session",
    }));
    const interjectDelegation = vi.fn(async () => ({
      ok: true as const,
      delegationId: "delegation-1",
      childSessionId: "bot-child-session",
      queued: true,
    }));
    const server = createXdtHelperMcpServer(
      {
        botDelegation: {
          listBots,
          delegateToBot,
          listDelegations,
          cancelDelegation,
          interjectDelegation,
        },
      },
      {
        agentKind: "claude-code",
        workingDir: "/repo",
        sessionId: "bot-parent-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-delegation-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const collaborationTool = (await client.listTools()).tools.find(
        (tool) => tool.name === "collaborate_with_bot",
      );
      expect(collaborationTool).toBeDefined();
      const oversized = await client.callTool({
        name: "collaborate_with_bot",
        arguments: {
          action: "delegate",
          target_bot_id: "bot-b",
          instruction: "x".repeat(12_001),
        },
      });
      expect(oversized.isError).toBe(true);
      expect(delegateToBot).not.toHaveBeenCalled();
      const status = parsePayload(await client.callTool({
        name: "collaborate_with_bot",
        arguments: { action: "status", target_bot_id: "bot-b" },
      }));
      expect(status).toMatchObject({
        ok: true,
        action: "status",
        bot: { id: "bot-b", name: "Dash Bot", activity: "idle" },
      });

      const delegated = parsePayload(await client.callTool({
        name: "collaborate_with_bot",
        arguments: {
          action: "delegate",
          target_bot_id: "bot-b",
          instruction: "Return a tracked compatibility report.",
        },
      }));
      expect(delegated).toMatchObject({
        ok: true,
        action: "delegate",
        expects_result: true,
        delegationId: "delegation-1",
      });
      expect(delegateToBot).toHaveBeenCalledWith(expect.objectContaining({
        callerSessionId: "bot-parent-session",
        targetBotId: "bot-b",
        objective: "Return a tracked compatibility report.",
      }));

      const discovered = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect(discovered).toMatchObject({ ok: true, category: "bots" });
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([
        "cancel_bot_delegation",
        "delegate_to_bot",
        "interject_bot_delegation",
        "list_bot_delegations",
        "list_bots",
        "start_cindy_task",
      ]);

      const interjected = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "interject_bot_delegation",
          args: { delegation_id: "delegation-1", text: "先别写代码，等我确认口径" },
        },
      });
      expect(parsePayload(interjected)).toMatchObject({ ok: true, queued: true });
      expect(interjectDelegation).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        delegationId: "delegation-1",
        text: "先别写代码，等我确认口径",
      });

      const listed = await client.callTool({
        name: "call_tool",
        arguments: { name: "list_bots", args: {} },
      });
      expect(parsePayload(listed)).toMatchObject({
        ok: true,
        bots: [{ id: "bot-b", name: "Dash Bot" }],
      });
      expect(listBots).toHaveBeenCalledWith({ callerSessionId: "bot-parent-session" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers and calls message_agent with the host-bound caller task", async () => {
    const messageAgent = vi.fn(async () => ({
      ok: true as const,
      targetBotId: "bot-b",
      targetBotName: "Dash Bot",
      targetSessionId: "bot-b-main",
      wakeKind: "queued" as const,
    }));
    const server = createXdtHelperMcpServer(
      { botMessaging: { messageAgent } },
      {
        agentKind: "claude-code",
        workingDir: "/repo",
        sessionId: "bot-a-main",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-message-agent-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const notified = parsePayload(await client.callTool({
        name: "collaborate_with_bot",
        arguments: {
          action: "notify",
          target_bot_id: "bot-b",
          instruction: "发布风险已同步。",
        },
      }));
      expect(notified).toMatchObject({
        ok: true,
        action: "notify",
        delivered: true,
        expects_result: false,
      });
      expect(messageAgent).toHaveBeenCalledWith({
        callerSessionId: "bot-a-main",
        targetBotId: "bot-b",
        message: "发布风险已同步。",
      });

      const discovered = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain(
        "message_agent",
      );

      const sent = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "message_agent",
          args: { target_bot_id: "bot-b", message: "请同步发布风险。" },
        },
      });
      expect(parsePayload(sent)).toMatchObject({
        ok: true,
        target_bot_id: "bot-b",
        target_session_id: "bot-b-main",
        wake_kind: "queued",
      });
      expect(messageAgent).toHaveBeenCalledWith({
        callerSessionId: "bot-a-main",
        targetBotId: "bot-b",
        message: "请同步发布风险。",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers and calls the arbitrary session queue tool through the entry tools", async () => {
    const listSessionQueue = vi.fn(async () => ({
      ok: true as const,
      messages: [],
    }));
    const server = createXdtHelperMcpServer(
      {
        sessionQueue: {
          listSessionQueue,
          listSessionQueuedCounts: vi.fn(async () => ({ ok: true as const, counts: {} })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-queue-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "history" },
        }),
      );
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain(
        "list_session_queue",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "list_session_queue",
          args: { session_id: "session-1" },
        },
      });

      expect(parsePayload(result)).toMatchObject({
        ok: true,
        session_id: "session-1",
        queued_count: 0,
        queue: [],
      });
      expect(listSessionQueue).toHaveBeenCalledWith("session-1");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers the complete session control surface through the control category", async () => {
    const server = createXdtHelperMcpServer(
      {
        sessionControl: {
          updateQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          cancelQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          steerSession: vi.fn(async () => ({
            ok: true as const,
            queuedMessageId: "steer-1",
          })),
          stopSessionTurn: vi.fn(async () => ({
            ok: true as const,
            status: "requested" as const,
            turnGeneration: 4,
          })),
          getSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            runtime: {
              sessionId: "target",
              phase: "idle" as const,
              recordStatus: "active" as const,
              attention: false,
              workflow: null,
              source: "persisted" as const,
              turnGeneration: null,
              startedAtMs: null,
              lastActivityAtMs: null,
              currentActionSummary: null,
              gracefulStopState: "none" as const,
            },
          })),
          setSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            status: "applied" as const,
            generation: 1,
            effectiveProfile: {
              agentKind: "codex" as const,
              model: "gpt-5.6-sol",
              providerId: "openai",
              effort: "high" as const,
              fastMode: false,
            },
            pendingMutation: null,
          })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-control-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "control" },
        }),
      );
      const names = (discovered.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "update_session_queued_message",
        "cancel_session_queued_message",
        "steer_session",
        "stop_session_turn",
        "get_session_runtime",
        "set_session_runtime",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps a Bot on the Bot-only helper surface", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const messageAgent = vi.fn(async () => ({
      ok: true as const,
      targetBotId: "bot-b",
      targetBotName: "Dash Bot",
      targetSessionId: "bot-b-main",
      wakeKind: "queued" as const,
    }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => "bot",
        sendToSession,
        botMessaging: { messageAgent },
      },
      {
        agentKind: "pi",
        workingDir: "/repo",
        sessionId: "bot-a-main",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-helper-surface-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual([{ name: "bots", tool_count: 1 }]);

      const forbiddenCategory = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "handoff" } }),
      );
      expect(forbiddenCategory).toMatchObject({
        ok: false,
        errorCode: "CAPABILITY_NOT_AVAILABLE",
      });

      const forbiddenCall = parsePayload(
        await client.callTool({
          name: "call_tool",
          arguments: {
            name: "send_to_session",
            args: { target_session_id: TARGET_SESSION_ID, message: "Do work" },
          },
        }),
      );
      expect(forbiddenCall).toMatchObject({
        ok: false,
        errorCode: "CAPABILITY_NOT_AVAILABLE",
      });
      expect(sendToSession).not.toHaveBeenCalled();

      const botTools = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect((botTools.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        "message_agent",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when the host cannot classify the Session surface", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => { throw new Error("db unavailable"); },
        sendToSession,
      },
      { agentKind: "pi", workingDir: "/repo", sessionId: "unknown-session" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-helper-restricted-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual([]);
      const forbiddenCall = parsePayload(
        await client.callTool({
          name: "call_tool",
          arguments: {
            name: "send_to_session",
            args: { target_session_id: TARGET_SESSION_ID, message: "Do work" },
          },
        }),
      );
      expect(forbiddenCall).toMatchObject({
        ok: false,
        errorCode: "CAPABILITY_NOT_AVAILABLE",
      });
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
