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
  it("exposes direct teammate creation without the discovery loop", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      bot: { id: "bot-new", name: "程序员", description: "负责开发" },
    }));
    const server = createXdtHelperMcpServer(
      { botProfiles: { create } },
      { agentKind: "pi", workingDir: "/repo", sessionId: "bot-parent-session" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-helper-create-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("create_teammate");
      const result = await client.callTool({
        name: "create_teammate",
        arguments: {
          name: "程序员",
          description: "负责开发",
          identity_source: "你是一个可靠的程序员伙伴。",
          welcome_message: "你好，我是程序员，以后开发工作可以直接找我。",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({
        ok: true,
        action: "created",
        bot: { id: "bot-new", name: "程序员" },
      });
      expect(create).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        name: "程序员",
        description: "负责开发",
        identitySource: "你是一个可靠的程序员伙伴。",
        welcomeMessage: "你好，我是程序员，以后开发工作可以直接找我。",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

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

  it("exposes one Session-task lifecycle without a named-Bot task path", async () => {
    const startSessionTask = vi.fn(async () => ({
      ok: true as const,
      delegationId: "session-task-1",
      childSessionId: "desktop-child-session",
      status: "running",
      deadlineAt: 1_788_000_000_000,
    }));
    const messageSessionTask = vi.fn(async () => ({
      ok: true as const,
      delegationId: "session-task-1",
      childSessionId: "desktop-child-session",
      resumed: false,
    }));
    const getSessionTask = vi.fn(async () => ({
      ok: true as const,
      task: { id: "session-task-1", status: "running" },
    }));
    const stopSessionTask = vi.fn(async () => ({
      ok: true as const,
      delegationId: "session-task-1",
      childSessionId: "desktop-child-session",
    }));
    const server = createXdtHelperMcpServer(
      {
        sessionTasks: {
          startSessionTask,
          messageSessionTask,
          getSessionTask,
          stopSessionTask,
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
      const tools = (await client.listTools()).tools;
      const sessionTaskTool = tools.find((tool) => tool.name === "start_session_task");
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "start_session_task",
          "check_session_task",
          "message_session_task",
          "stop_session_task",
        ]),
      );
      expect(tools.map((tool) => tool.name)).not.toContain("collaborate_with_bot");
      expect(sessionTaskTool?.description).toContain("real independent Cindy Session task");
      expect(sessionTaskTool?.description).toContain("never calls a Cindy Bot");
      expect(
        (sessionTaskTool?.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).toHaveProperty("working_dir");
      expect((sessionTaskTool?.inputSchema as { properties?: Record<string, unknown> }).properties)
        .not.toHaveProperty("max_depth");
      const oversized = await client.callTool({
        name: "start_session_task",
        arguments: {
          instruction: "x".repeat(12_001),
        },
      });
      expect(oversized.isError).toBe(true);
      expect(startSessionTask).not.toHaveBeenCalled();
      const sessionTask = parsePayload(
        await client.callTool({
          name: "start_session_task",
          arguments: {
            title: "Build the demo",
            working_dir: "/repo",
            instruction: "Build and verify a standalone HTML demo.",
          },
        }),
      );
      expect(sessionTask).toMatchObject({
        ok: true,
        action: "start_session_task",
        task_id: "session-task-1",
        session_id: "desktop-child-session",
        deadline_at: 1_788_000_000_000,
      });
      expect(sessionTask).not.toHaveProperty("delegationId");
      expect(startSessionTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          callerSessionId: "bot-parent-session",
          objective: "Build and verify a standalone HTML demo.",
          title: "Build the demo",
          workingDir: "/repo",
        }),
      );

      const replied = parsePayload(
        await client.callTool({
          name: "message_session_task",
          arguments: {
            task_id: "session-task-1",
            decision: "approve",
          },
        }),
      );
      expect(replied).toMatchObject({
        ok: true,
        action: "message_session_task",
        task_id: "session-task-1",
      });
      expect(messageSessionTask).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        taskId: "session-task-1",
        reply: { kind: "approve" },
      });

      const taskStatus = parsePayload(
        await client.callTool({
          name: "check_session_task",
          arguments: { task_id: "session-task-1" },
        }),
      );
      expect(taskStatus).toMatchObject({
        ok: true,
        action: "check_session_task",
        task_id: "session-task-1",
        task: { id: "session-task-1", status: "running" },
      });
      expect(getSessionTask).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        taskId: "session-task-1",
      });

      const stopped = parsePayload(
        await client.callTool({
          name: "stop_session_task",
          arguments: { task_id: "session-task-1" },
        }),
      );
      expect(stopped).toMatchObject({
        ok: true,
        action: "stop_session_task",
        task_id: "session-task-1",
      });
      expect(stopSessionTask).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        taskId: "session-task-1",
      });

      const discovered = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect(discovered).toMatchObject({ ok: true, category: "bots", tools: [] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends one bounded direct message through send_to_agent", async () => {
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
      const notified = parsePayload(
        await client.callTool({
          name: "send_to_agent",
          arguments: {
            target_id: "bot-b",
            message: "发布风险已同步。",
          },
        }),
      );
      expect(notified).toMatchObject({
        ok: true,
        action: "send_to_agent",
        delivered: true,
      });
      expect(messageAgent).toHaveBeenCalledWith({
        callerSessionId: "bot-a-main",
        targetBotId: "bot-b",
        message: "发布风险已同步。",
      });

      const discovered = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect(discovered).toMatchObject({ ok: true, category: "bots", tools: [] });
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
      expect(overview.categories).toEqual([]);

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
      expect((botTools.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([]);
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
