import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const parse = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("create_project MCP", () => {
  it("discovers and dispatches through the real transport, validates arguments and rechecks the task surface", async () => {
    let surface: "default" | "bot" | "restricted" = "default";
    let sessionId: string | undefined = "caller";
    let remoteHostId: string | undefined;
    const createProject = vi.fn(async () => ({
      ok: true as const,
      workingDir: "/project",
    }));
    const server = createXdtHelperMcpServer(
      { createProject, resolveSurface: async () => surface },
      {
        agentKind: "pi",
        workingDir: "/repo",
        getSessionContext: () => ({
          agentKind: "pi",
          workingDir: "/repo",
          sessionId,
          remoteHostId,
        }),
      },
    );
    const client = new Client({ name: "create-project-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = (args: unknown) =>
      client.callTool({
        name: "call_tool",
        arguments: { name: "create_project", args },
      });
    try {
      const discovered = parse(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "control" },
        }),
      );
      expect(discovered.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "create_project" }),
        ]),
      );
      expect(parse(await call({ working_dir: " /project " }))).toMatchObject({
        ok: true,
        working_dir: "/project",
      });
      expect(createProject).toHaveBeenCalledWith({
        callerSessionId: "caller",
        workingDir: "/project",
      });
      expect(parse(await call({ working_dir: " " }))).toMatchObject({
        errorCode: "INVALID_ARGS",
      });
      expect(
        parse(await call({ working_dir: "/project", create_directory: true })),
      ).toMatchObject({ errorCode: "INVALID_ARGS" });
      remoteHostId = "ssh";
      expect(parse(await call({ working_dir: "/project" }))).toMatchObject({
        errorCode: "UNSUPPORTED_CAPABILITY",
      });
      remoteHostId = undefined;
      sessionId = undefined;
      expect(parse(await call({ working_dir: "/project" }))).toMatchObject({
        errorCode: "NO_SESSION_CONTEXT",
      });
      sessionId = "caller";
      for (const restricted of ["bot", "restricted"] as const) {
        surface = restricted;
        const categories = parse(
          await client.callTool({ name: "list_tools", arguments: {} }),
        );
        expect(categories.categories ?? []).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "control" }),
          ]),
        );
        expect((await call({ working_dir: "/project" })).isError).toBe(true);
      }
      expect(createProject).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
