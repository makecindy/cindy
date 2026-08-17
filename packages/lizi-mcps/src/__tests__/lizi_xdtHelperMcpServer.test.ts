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
    const server = createXdtHelperMcpServer(
      {
        botDelegation: {
          listBots,
          delegateToBot,
          listDelegations,
          cancelDelegation,
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
      const discovered = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect(discovered).toMatchObject({ ok: true, category: "bots" });
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([
        "cancel_bot_delegation",
        "delegate_to_bot",
        "list_bot_delegations",
        "list_bots",
      ]);

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
});
