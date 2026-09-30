import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const parse = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("move_session MCP", () => {
  it.each(["pi", "codex", "claude-code"] as const)(
    "moves existing tasks with validated context on %s",
    async (agentKind) => {
      let surface: "default" | "bot" | "restricted" = "default";
      let sessionId: string | undefined = "caller";
      let remoteHostId: string | undefined;
      const moveSession = vi.fn(
        async (params: { sessionId: string; workingDir: string | null }) => ({
          ok: true as const,
          sessionId: params.sessionId,
          workingDir: params.workingDir ?? "/old",
          workspaceKind: params.workingDir ? "project" : "dialogue",
        }),
      );
      const server = createXdtHelperMcpServer(
        { moveSession, resolveSurface: async () => surface },
        {
          agentKind,
          workingDir: "/caller",
          getSessionContext: () => ({
            agentKind,
            sessionId,
            remoteHostId,
            workingDir: "/caller",
          }),
        },
      );
      const client = new Client({ name: "move-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      const call = async (args: object) =>
        parse(
          await client.callTool({
            name: "call_tool",
            arguments: { name: "move_session", args },
          }),
        );
      try {
        const discovery = parse(
          await client.callTool({
            name: "list_tools",
            arguments: { category: "control" },
          }),
        );
        expect(
          discovery.tools.map((tool: { name: string }) => tool.name),
        ).toContain("move_session");
        expect(
          await call({ session_id: "target", working_dir: "/next" }),
        ).toMatchObject({
          ok: true,
          session_id: "target",
          working_dir: "/next",
          workspace_kind: "project",
        });
        expect(moveSession).toHaveBeenLastCalledWith({
          callerSessionId: "caller",
          sessionId: "target",
          workingDir: "/next",
        });
        expect(
          await call({ session_id: "target", working_dir: null }),
        ).toMatchObject({
          ok: true,
          working_dir: "/old",
          workspace_kind: "dialogue",
        });
        moveSession.mockClear();
        for (const args of [
          { session_id: "target" },
          { session_id: "target", working_dir: "" },
          { session_id: "target", working_dir: null, status: "deleted" },
        ]) {
          expect(await call(args)).toMatchObject({ ok: false });
        }
        expect(
          await call({ session_id: "caller", working_dir: "/next" }),
        ).toMatchObject({ errorCode: "PRECONDITION_FAILED" });
        remoteHostId = "ssh";
        expect(
          await call({ session_id: "target", working_dir: "/next" }),
        ).toMatchObject({ errorCode: agentKind === "pi" ? "UNSUPPORTED_CAPABILITY" : "CAPABILITY_NOT_AVAILABLE" });
        remoteHostId = undefined;
        sessionId = undefined;
        expect(
          await call({ session_id: "target", working_dir: null }),
        ).toMatchObject({ errorCode: "NO_SESSION_CONTEXT" });
        sessionId = "caller";
        // Bot surface now includes project/session management.
        surface = "bot";
        expect(
          await call({ session_id: "target", working_dir: null }),
        ).toMatchObject({
          ok: true,
          workspace_kind: "dialogue",
        });
        expect(moveSession).toHaveBeenLastCalledWith({
          callerSessionId: "caller",
          sessionId: "target",
          workingDir: null,
        });
        moveSession.mockClear();
        surface = "restricted";
        expect(
          await call({ session_id: "target", working_dir: null }),
        ).toMatchObject({ ok: false });
        expect(moveSession).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
