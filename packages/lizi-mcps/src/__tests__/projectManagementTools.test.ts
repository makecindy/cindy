import { expect, it, vi } from "vitest";
import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";

const pluginCaller = {
  kind: "plugin" as const,
  pluginId: "my-projects",
  dataOwnerId: "owner",
  ownerGeneration: 1,
};

function setup(hostCaller?: typeof pluginCaller) {
  const list = vi.fn(async () => ({
    ok: true as const,
    projects: [
      {
        workingDir: "/work/repo",
        directoryName: "repo",
        alias: "My Project",
        hidden: false,
        exists: true,
        lastUsedAt: "2026-11-20T00:00:00.000Z",
      },
    ],
    total: 1,
    nextOffset: null,
    projectsRoot: { path: "/work", source: "default" as const, exists: true },
  }));
  const denied = {
    ok: false as const,
    errorCode: "UNEXPECTED_WRITE",
    message: "The write callback should not run.",
  };
  const createProject = vi.fn(async () => denied);
  const rename = vi.fn(async () => denied);
  const remove = vi.fn(async () => denied);
  const updateInfo = vi.fn(async () => denied);
  const server = createXdtHelperMcpServer(
    { createProject, projectManagement: { list, rename, remove, updateInfo } },
    { agentKind: "pi", workingDir: "", hostCaller },
  );
  return {
    list,
    writes: [createProject, rename, remove, updateInfo],
    async call(name: string, args: Record<string, unknown>) {
      const result = await server.hostTools.call(name, args);
      return JSON.parse((result.content[0] as { text: string }).text);
    },
  };
}

it("returns project aliases for a plugin selecting another computer without a task", async () => {
  const { call, list } = setup(pluginCaller);
  expect(
    await call("list_projects", { device: "other-computer" }),
  ).toMatchObject({
    ok: true,
    device: "other-computer",
    projects: [{ working_dir: "/work/repo", alias: "My Project" }],
  });
  expect(list).toHaveBeenCalledWith({
    callerSessionId: undefined,
    device: "other-computer",
    includeHidden: true,
    offset: 0,
    limit: 100,
  });
});

it("rejects project writes before reaching the Host when the plugin has no task", async () => {
  const { call, writes } = setup(pluginCaller);
  for (const [name, args] of [
    ["create_project", { working_dir: "/work/repo" }],
    ["rename_project", { working_dir: "/work/repo", name: "Renamed" }],
    ["remove_project", { working_dir: "/work/repo" }],
    [
      "update_project_info",
      { project_key: "local:/work/repo", field: "name", value: "Renamed" },
    ],
  ] as const) {
    expect(await call(name, args)).toMatchObject({
      ok: false,
      errorCode: "NO_SESSION_CONTEXT",
    });
  }
  for (const write of writes) expect(write).not.toHaveBeenCalled();
});

it("requires an authenticated caller for the project catalog", async () => {
  const { call, list } = setup();
  expect(await call("list_projects", {})).toMatchObject({
    ok: false,
    errorCode: "NO_SESSION_CONTEXT",
  });
  expect(list).not.toHaveBeenCalled();
});
