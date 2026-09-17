import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const parse = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("project management MCP", () => {
  it.each(["pi", "codex", "claude-code"] as const)(
    "discovers and dispatches project operations for %s with runtime surface checks",
    async (agentKind) => {
      let surface: "default" | "bot" | "restricted" = "default";
      let remoteHostId: string | undefined;
      const list = vi.fn(async () => ({
        ok: true as const,
        projects: [
          {
            workingDir: "/repo",
            directoryName: "repo",
            alias: "Work",
            hidden: true,
            exists: true,
            lastUsedAt: "2026-09-17T00:00:00Z",
          },
        ],
        total: 1,
        nextOffset: null,
      }));
      const rename = vi.fn(async () => ({
        ok: true as const,
        workingDir: "/repo",
        alias: null,
      }));
      const remove = vi.fn(async () => ({
        ok: true as const,
        workingDir: "/repo",
        removed: true,
      }));
      const server = createXdtHelperMcpServer(
        {
          projectManagement: { list, rename, remove },
          resolveSurface: async () => surface,
        },
        {
          agentKind,
          workingDir: "/repo",
          getSessionContext: () => ({
            agentKind,
            workingDir: "/repo",
            sessionId: "caller",
            remoteHostId,
          }),
        },
      );
      const client = new Client({ name: "projects-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      const call = async (name: string, args: object) =>
        parse(
          await client.callTool({
            name: "call_tool",
            arguments: { name, args },
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
        ).toEqual(
          expect.arrayContaining([
            "list_projects",
            "rename_project",
            "remove_project",
          ]),
        );
        expect(
          discovery.tools.map((tool: { name: string }) => tool.name),
        ).not.toContain("set_project_visibility");
        expect(
          await call("set_project_visibility", {
            working_dir: "/repo",
            hidden: false,
          }),
        ).toMatchObject({ errorCode: "UNKNOWN_TOOL" });
        expect(await call("list_projects", {})).toMatchObject({
          ok: true,
          total: 1,
          next_offset: null,
          projects: [
            {
              working_dir: "/repo",
              directory_name: "repo",
              alias: "Work",
              hidden: true,
            },
          ],
        });
        expect(list).toHaveBeenCalledWith({
          callerSessionId: "caller",
          includeHidden: true,
          offset: 0,
          limit: 100,
        });
        expect(
          await call("rename_project", { working_dir: "/repo", name: "" }),
        ).toMatchObject({ ok: true, alias: null });
        expect(rename).toHaveBeenCalledWith({
          callerSessionId: "caller",
          workingDir: "/repo",
          name: "",
        });
        expect(
          await call("remove_project", {
            working_dir: "/repo",
          }),
        ).toMatchObject({ ok: true, removed: true });
        expect(remove).toHaveBeenCalledWith({
          callerSessionId: "caller",
          workingDir: "/repo",
        });
        expect(
          await call("rename_project", {
            working_dir: "/repo",
            name: "x".repeat(81),
          }),
        ).toMatchObject({ errorCode: "INVALID_ARGS" });
        expect(
          await call("remove_project", { working_dir: "/repo", hidden: false }),
        ).toMatchObject({ errorCode: "INVALID_ARGS" });
        expect(await call("list_projects", { limit: 501 })).toMatchObject({
          errorCode: "INVALID_ARGS",
        });
        remoteHostId = "ssh";
        expect(
          (
            await call("rename_project", {
              working_dir: "/repo",
              name: "Remote",
            })
          ).ok,
        ).toBe(false);
        remoteHostId = undefined;
        for (const nextSurface of ["bot", "restricted"] as const) {
          surface = nextSurface;
          for (const tool of [
            "list_projects",
            "rename_project",
            "remove_project",
          ]) {
            expect(await call(tool, {})).toMatchObject({
              errorCode: "CAPABILITY_NOT_AVAILABLE",
            });
          }
        }
        expect(list).toHaveBeenCalledTimes(1);
        expect(rename).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
