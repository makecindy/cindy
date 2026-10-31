/**
 * cindy_scheduler 跨电脑路由:device 缺省仍是本机且形状不变;all / 指定电脑按电脑分组并写明
 * 不可用原因;写操作只作用于一台电脑;对方旧版本明确报不支持。
 */
import { describe, expect, it, vi } from "vitest";
import type { Scheduler } from "@cindy/maker-scheduler";

import {
  SchedulerToolRegistry,
  type SchedulerToolResult,
} from "../cindy_schedulerToolRegistry.js";
import {
  registerScheduleCreateTool,
  registerScheduleDeleteTool,
  registerScheduleGetTool,
  registerScheduleMoveTool,
  registerScheduleListRunsTool,
  registerScheduleListTool,
  registerSchedulePauseTool,
  registerScheduleResumeTool,
  registerScheduleRunNowTool,
  registerScheduleUpdateTool,
  type SchedulerDevice,
  type SchedulerRemoteDeps,
  type SchedulerRemoteResult,
} from "../scheduler/index.js";
import { filterSchedulesByText } from "../scheduler/list.js";

const LOCAL = [
  {
    id: "l1",
    name: "local heartbeat",
    prompt: "跟进 https://github.com/o/r/pull/1",
    status: "active",
  },
  { id: "l2", name: "weekly report", prompt: "report", status: "paused" },
];
const REMOTE = [
  {
    id: "r1",
    name: "PR heartbeat",
    prompt: "x",
    preRunHook: { command: "node gate.mjs https://github.com/o/r/pull/7" },
  },
  { id: "r2", name: "other", prompt: "y", targetSessionId: "sess-9" },
];
const DEVICES: SchedulerDevice[] = [
  { deviceId: "local", deviceName: "This Mac", local: true, available: true },
  {
    deviceId: "mbp",
    deviceName: "Dash Macbook Pro",
    local: false,
    available: true,
  },
  { deviceId: "old", deviceName: "Old PC", local: false, available: true },
  {
    deviceId: "off",
    deviceName: "Sleeping",
    local: false,
    available: false,
    unavailableReason: "REMOTE_DEVICE_OFFLINE",
  },
];

function setup(
  opts: {
    remote?: boolean;
    listDevices?: () => Promise<SchedulerDevice[]>;
  } = {},
) {
  const scheduler = {
    list: vi.fn(async (filter?: { status?: string }) =>
      filter?.status
        ? LOCAL.filter((row) => row.status === filter.status)
        : LOCAL,
    ),
    get: vi.fn(
      async (id: string) => LOCAL.find((row) => row.id === id) ?? null,
    ),
    listRuns: vi.fn(async () => [{ id: "run-local" }]),
    pause: vi.fn(async (id: string) => ({ id, status: "paused" })),
    resume: vi.fn(async (id: string) => ({ id, status: "active" })),
    delete: vi.fn(async () => undefined),
    runNow: vi.fn(async () => ({ runId: "run-1" })),
    resolveInflightRunForSession: vi.fn(() => undefined),
    updateFromCurrent: vi.fn(async (id: string) => ({ id })),
  };
  const invoke = vi.fn(
    async (
      deviceId: string,
      op: string,
      args: unknown[],
    ): Promise<SchedulerRemoteResult> => {
      if (deviceId === "old") {
        return {
          ok: false,
          code: "REMOTE_UNSUPPORTED",
          message: "目标电脑的版本不支持远程管理定时任务",
        };
      }
      if (op === "list") return { ok: true, data: REMOTE };
      if (op === "get")
        return {
          ok: true,
          data: REMOTE.find((row) => row.id === args[0]) ?? null,
        };
      if (op === "list-runs") return { ok: true, data: [{ id: "run-remote" }] };
      if (op === "delete") return { ok: true, data: null };
      return { ok: true, data: { id: args[0], op } };
    },
  );
  const remote: SchedulerRemoteDeps = {
    listDevices: opts.listDevices ?? (async () => DEVICES),
    invoke,
  };
  const registry = new SchedulerToolRegistry();
  const deps = {
    getScheduler: () => scheduler as unknown as Scheduler,
    ...(opts.remote === false ? {} : { remote }),
  };
  registerScheduleListTool(registry, deps);
  registerScheduleGetTool(registry, deps);
  registerScheduleListRunsTool(registry, deps);
  registerScheduleUpdateTool(registry, deps, () => ({
    sessionId: "caller",
    agentKind: "claude-code",
    workingDir: "",
  }));
  registerSchedulePauseTool(registry, deps);
  registerScheduleResumeTool(registry, deps);
  registerScheduleRunNowTool(registry, deps);
  registerScheduleDeleteTool(registry, deps);
  return { registry, scheduler, invoke };
}

function parse(result: SchedulerToolResult): Record<string, any> {
  const [block] = result.content;
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text);
}

describe("cindy_scheduler cross-device routing", () => {
  it("keeps the local shape by default and states that the result is local only", async () => {
    const s = setup();
    const payload = parse(await s.registry.call("schedule_list", {}));
    expect(payload).toEqual({
      ok: true,
      data: LOCAL,
      scope: "local",
      note: expect.stringContaining('device="all"'),
    });
    expect(s.invoke).not.toHaveBeenCalled();
    // 宿主没有跨电脑能力时不提示一个用不了的参数。
    expect(
      parse(await setup({ remote: false }).registry.call("schedule_list", {})),
    ).toEqual({
      ok: true,
      data: LOCAL,
      scope: "local",
    });
  });

  it("groups device=all per computer and keeps unreachable or older computers with a reason", async () => {
    const s = setup();
    const payload = parse(
      await s.registry.call("schedule_list", { device: "all" }),
    );
    expect(payload.partial).toBe(true);
    expect(payload.groups.map((g: any) => [g.deviceId, g.ok, g.code])).toEqual([
      ["local", true, undefined],
      ["mbp", true, undefined],
      ["old", false, "REMOTE_UNSUPPORTED"],
      ["off", false, "REMOTE_DEVICE_OFFLINE"],
    ]);
    expect(payload.groups[1]).toMatchObject({
      deviceName: "Dash Macbook Pro",
      data: [REMOTE[0], { ...REMOTE[1], targetSessionId: "mbp::sess-9" }],
    });
    // 离线电脑不发请求。
    expect(s.invoke.mock.calls.map(([deviceId]) => deviceId).sort()).toEqual([
      "mbp",
      "old",
    ]);
  });

  it("filters by text on every computer, including the check script command", async () => {
    const s = setup();
    const payload = parse(
      await s.registry.call("schedule_list", {
        device: "all",
        query: "PULL/7",
      }),
    );
    expect(payload.groups[0].data).toEqual([]);
    expect(payload.groups[1].data).toEqual([REMOTE[0]]);
    const local = parse(
      await s.registry.call("schedule_list", {
        query: "pull/1",
        status: "active",
      }),
    );
    expect(local.data).toEqual([LOCAL[0]]);
    expect(filterSchedulesByText(REMOTE, "sess-9")).toEqual([REMOTE[1]]);
  });

  it("reads one named computer and reports an unknown one", async () => {
    const s = setup();
    expect(
      parse(await s.registry.call("schedule_get", { id: "r1", device: "mbp" }))
        .groups,
    ).toEqual([
      expect.objectContaining({ deviceId: "mbp", ok: true, data: REMOTE[0] }),
    ]);
    expect(
      parse(
        await s.registry.call("schedule_list_runs", {
          scheduleId: "r1",
          device: "mbp",
          limit: 5,
        }),
      ).groups[0].data,
    ).toEqual([{ id: "run-remote" }]);
    expect(s.invoke).toHaveBeenLastCalledWith("mbp", "list-runs", ["r1", 5]);
    const missing = await s.registry.call("schedule_get", {
      id: "r1",
      device: "nope",
    });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({
      ok: false,
      code: "DEVICE_NOT_FOUND",
    });
  });

  it("still returns local results when the computer list cannot be read", async () => {
    const s = setup({
      listDevices: async () => {
        throw new Error("offline");
      },
    });
    const all = parse(
      await s.registry.call("schedule_list", { device: "all" }),
    );
    expect(all).toMatchObject({
      partial: true,
      discoveryError: "DEVICE_DISCOVERY_FAILED",
    });
    expect(all.groups).toEqual([
      expect.objectContaining({ deviceId: "local", ok: true, data: LOCAL }),
    ]);
    expect(
      parse(await s.registry.call("schedule_list", { device: "mbp" })),
    ).toMatchObject({
      ok: false,
      code: "DEVICE_DISCOVERY_FAILED",
    });
  });

  it("marks every default local read as local, so a local miss is not read as absent everywhere", async () => {
    const s = setup();
    expect(
      parse(await s.registry.call("schedule_get", { id: "nope" })),
    ).toEqual({
      ok: true,
      data: null,
      scope: "local",
    });
    expect(
      parse(await s.registry.call("schedule_list_runs", { scheduleId: "l1" })),
    ).toEqual({ ok: true, data: [{ id: "run-local" }], scope: "local" });
  });

  it("requires an explicit timeout when changing the check script on another computer", async () => {
    // 对方入口整对象替换 preRunHook：省略会清成不限时，先读后写会覆盖并发修改。
    const s = setup();
    const missing = await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      preRunHook: { command: "node new.mjs" },
    });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(parse(missing).message).toContain("timeoutMs");
    expect(s.invoke).not.toHaveBeenCalled();
    await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      preRunHook: { command: "node new.mjs", timeoutMs: 5000 },
    });
    // 一次写入，不先读。
    expect(s.invoke.mock.calls).toEqual([
      [
        "mbp",
        "update",
        ["r1", { preRunHook: { command: "node new.mjs", timeoutMs: 5000 } }],
      ],
    ]);
    // null = 不限时：对方入口的表达是不带 timeoutMs 的整对象，同样一次写入。
    s.invoke.mockClear();
    await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      preRunHook: { command: "node new.mjs", timeoutMs: null },
    });
    expect(s.invoke.mock.calls).toEqual([
      ["mbp", "update", ["r1", { preRunHook: { command: "node new.mjs" } }]],
    ]);
  });

  it("addresses bound tasks on another computer with its device prefix both ways", async () => {
    const s = setup();
    // 读：绑定任务 id 带上设备前缀，可直接交给 send_to_session / get_chat_history。
    const read = parse(
      await s.registry.call("schedule_get", { id: "r2", device: "mbp" }),
    );
    expect(read.groups[0].data).toMatchObject({
      id: "r2",
      targetSessionId: "mbp::sess-9",
    });
    // 按带前缀的 id 也能筛到。
    const found = parse(
      await s.registry.call("schedule_list", {
        device: "mbp",
        query: "mbp::sess-9",
      }),
    );
    expect(found.groups[0].data).toEqual([
      { ...REMOTE[1], targetSessionId: "mbp::sess-9" },
    ]);
    // 写：同一台电脑的前缀去掉后再交给对方入口，写结果同样带前缀。
    s.invoke.mockImplementationOnce(async () => ({
      ok: true,
      data: { id: "r2", targetSessionId: "sess-1" },
    }));
    const written = parse(
      await s.registry.call("schedule_update", {
        id: "r2",
        device: "mbp",
        targetSessionId: "mbp::sess-1",
      }),
    );
    expect(s.invoke).toHaveBeenLastCalledWith("mbp", "update", [
      "r2",
      { targetSessionId: "sess-1" },
    ]);
    expect(written.data).toEqual({ id: "r2", targetSessionId: "mbp::sess-1" });
    // 指向别的电脑的任务不能绑定。
    const calls = s.invoke.mock.calls.length;
    // 指向别的电脑、去前缀后为空或格式残缺的都拒绝，不写成「未绑定」。
    for (const targetSessionId of [
      "pc::sess-1",
      "mbp::",
      "::sess-1",
      "mbp::a::b",
    ]) {
      const rejected = await s.registry.call("schedule_update", {
        id: "r2",
        device: "mbp",
        targetSessionId,
      });
      expect(parse(rejected)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
    }
    expect(s.invoke.mock.calls.length).toBe(calls);
  });

  it("runs write tools on the named computer only", async () => {
    const s = setup();
    expect(
      parse(
        await s.registry.call("schedule_pause", { id: "r1", device: "mbp" }),
      ),
    ).toEqual({
      ok: true,
      deviceId: "mbp",
      data: { id: "r1", op: "pause" },
    });
    expect(
      parse(
        await s.registry.call("schedule_delete", { id: "r1", device: "mbp" }),
      ),
    ).toEqual({
      ok: true,
      deviceId: "mbp",
      data: { deleted: "r1" },
    });
    await s.registry.call("schedule_resume", { id: "r1", device: "mbp" });
    await s.registry.call("schedule_run_now", { id: "r1", device: "mbp" });
    await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      name: "renamed",
      intervalMs: null,
    });
    expect(s.invoke.mock.calls).toEqual([
      ["mbp", "pause", ["r1"]],
      ["mbp", "delete", ["r1"]],
      ["mbp", "resume", ["r1"]],
      ["mbp", "run-now", ["r1"]],
      ["mbp", "update", ["r1", { name: "renamed", intervalMs: null }]],
    ]);
    for (const method of [
      "pause",
      "delete",
      "resume",
      "runNow",
      "updateFromCurrent",
    ] as const) {
      expect(s.scheduler[method]).not.toHaveBeenCalled();
    }
    // 不传 device 仍是本机。
    await s.registry.call("schedule_pause", { id: "l1" });
    expect(s.scheduler.pause).toHaveBeenCalledWith("l1", undefined);
  });

  // PR #6830, unit: the real MCP entry must retain explicit clearing across JSON;
  // replacing null with undefined here would silently keep the old remote route.
  it("forwards model selection clearing as JSON null without changing omitted fields", async () => {
    const s = setup();
    const patch = { modelAgentDeviceId: null, modelAgentKind: null, model: null, providerId: null, effort: null, fastMode: false };
    const result = parse(await s.registry.call("schedule_update", { id: "r1", device: "mbp", ...patch }));
    expect(result.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(s.invoke.mock.calls[0]))).toEqual(["mbp", "update", ["r1", patch]]);
    expect(s.scheduler.updateFromCurrent).not.toHaveBeenCalled();
  });

  it("rejects writes that cannot be expressed on another computer instead of guessing", async () => {
    const s = setup();
    for (const args of [{ id: "r1", device: "all" }]) {
      const result = await s.registry.call("schedule_delete", args);
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
    }
    for (const patch of [
      { bindToCurrentSession: true },
      { workingDir: null },
      { cronExpr: "not a cron" },
      // 运行位置 id 相对本机的设备目录,对那台电脑没有意义。
      { agentDeviceId: "studio", model: "claude-opus-5-5" },
    ]) {
      const result = await s.registry.call("schedule_update", {
        id: "r1",
        device: "mbp",
        ...patch,
      });
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
    }
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("cannot produce the legacy full-form patch that the remote IPC entry rewrites", async () => {
    // 对方电脑的 maker:schedule:update 把「device-link 来源 + 带 manual 与 notify、不带
    // intervalMs」认作旧版手机的全量表单并清空间隔 / 重写模型选择。本工具的 schema 不收
    // manual，因此 partial patch 到不了那个形状；若要给本工具加 manual，必须先处理这一点。
    const s = setup();
    const result = await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      cronExpr: "0 9 * * *",
      manual: true,
      notify: { desktop: true, feishu: false },
    });
    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: "INVALID_ARGS",
    });
    await s.registry.call("schedule_update", {
      id: "r1",
      device: "mbp",
      cronExpr: "0 9 * * *",
      agentKind: "codex",
      notify: { desktop: true, feishu: false },
    });
    expect(s.invoke).toHaveBeenCalledOnce();
    expect(s.invoke.mock.calls[0]![2]).toEqual([
      "r1",
      {
        cronExpr: "0 9 * * *",
        agentKind: "codex",
        notify: { desktop: true, feishu: false },
      },
    ]);
  });

  it("reports an older or absent remote host explicitly", async () => {
    const s = setup();
    const old = await s.registry.call("schedule_pause", {
      id: "r1",
      device: "old",
    });
    expect(old.isError).toBe(true);
    expect(parse(old)).toMatchObject({ ok: false, code: "REMOTE_UNSUPPORTED" });
    const none = setup({ remote: false });
    for (const [tool, args] of [
      ["schedule_list", { device: "all" }],
      ["schedule_resume", { id: "r1", device: "mbp" }],
    ] as const) {
      expect(parse(await none.registry.call(tool, args))).toMatchObject({
        ok: false,
        code: "REMOTE_UNSUPPORTED",
      });
    }
  });
});


describe('remote schedule create and move', () => {
  const source = {
    id: 'src',
    name: '游戏领域雷达',
    prompt: '围绕主题搜集动态',
    kind: 'cron',
    cronExpr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'pi',
    model: 'grok-4.6',
    providerId: 'xai',
    status: 'active',
    notify: { desktop: true, feishu: false },
    useWorktree: false,
    workingDir: '/Users/elfcv/Documents/games',
    agentDeviceId: 'spark',
    targetSessionId: 'mac-session',
    preRunHook: { command: 'node check.mjs' },
  };
  function setup(opts: { create?: () => Promise<SchedulerRemoteResult> } = {}) {
    const created = {
      ...source,
      id: 'dst',
      providerId: 'xai-2fdb5bc7',
      workingDir: undefined,
      agentDeviceId: undefined,
      targetSessionId: undefined,
      preRunHook: undefined,
      workspaceKind: 'dialogue',
      status: 'active',
    };
    const scheduler = {
      get: vi.fn(async (id: string) => (id === 'src' ? source : null)),
      list: vi.fn(async () => [source]),
      create: vi.fn(async () => created),
      pause: vi.fn(async (id: string) => ({ id, status: 'paused' })),
      delete: vi.fn(async () => undefined),
    };
    const remoteRows = new Map<string, any>();
    const invoke = vi.fn(async (_deviceId: string, op: string, args: unknown[]): Promise<SchedulerRemoteResult> => {
      if (op === 'list') return { ok: true, data: [...remoteRows.values()] };
      if (op === 'get') return { ok: true, data: remoteRows.get(String(args[0])) ?? null };
      if (op === 'create') {
        if (opts.create) return opts.create();
        const row = { ...(args[0] as object), id: 'dst', status: 'active' };
        remoteRows.set('dst', row);
        return { ok: true, data: row };
      }
      if (op === 'pause') {
        const row = remoteRows.get(String(args[0]));
        if (row) row.status = 'paused';
        return { ok: true, data: row ?? null };
      }
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const registry = new SchedulerToolRegistry();
    const deps = {
      getScheduler: () => scheduler as unknown as Scheduler,
      remote: { listDevices: async () => [], invoke },
      listModels: vi.fn(async () => ({
        ok: true as const,
        pi: [{ id: 'grok-4.6', label: 'Grok 4.6', providers: [{ id: 'xai-2fdb5bc7', name: 'xAI' }], defaultProviderId: 'xai-2fdb5bc7' }],
      })),
    };
    registerScheduleCreateTool(registry, deps);
    registerScheduleMoveTool(registry, deps);
    return { registry, invoke, scheduler, deps, remoteRows, created };
  }

  it('creates on the named computer and does not touch the local scheduler', async () => {
    const s = setup();
    const result = parse(await s.registry.call('schedule_create', {
      device: 'spark',
      name: '游戏领域雷达',
      prompt: '围绕主题搜集动态',
      cronExpr: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'pi',
      model: 'grok-4.6',
      providerId: 'xai-2fdb5bc7',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
    }));
    expect(result.ok).toBe(true);
    expect(s.invoke).toHaveBeenCalledWith('spark', 'create', [expect.objectContaining({
      name: '游戏领域雷达',
      providerId: 'xai-2fdb5bc7',
    })]);
    expect(s.scheduler.create).not.toHaveBeenCalled();
  });

  it('rejects binding the current session when creating remotely', async () => {
    const s = setup();
    const result = parse(await s.registry.call('schedule_create', {
      device: 'spark',
      bindToCurrentSession: true,
      name: 'n',
      prompt: 'p',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'pi',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
    }));
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it('moves an active schedule, remaps the provider, and pauses the source only after get', async () => {
    const s = setup();
    const result = parse(await s.registry.call('schedule_move', { id: 'src', targetDevice: 'spark' }));
    expect(result).toMatchObject({
      ok: true,
      sourceId: 'src',
      targetId: 'dst',
      targetDevice: 'spark',
      sourceAction: 'pause',
      omitted: expect.arrayContaining(['workingDir', 'targetSessionId', 'agentDeviceId', 'preRunHook']),
    });
    const createArgs = s.invoke.mock.calls.find((call) => call[1] === 'create')?.[2][0] as {
      providerId?: string;
      workspaceKind?: string;
      workingDir?: string;
      agentDeviceId?: string;
    };
    expect(createArgs).toMatchObject({ providerId: 'xai-2fdb5bc7', workspaceKind: 'dialogue' });
    expect(createArgs.workingDir).toBeUndefined();
    expect(createArgs.agentDeviceId).toBeUndefined();
    expect(s.scheduler.pause).toHaveBeenCalledWith('src');
    const createAt = s.invoke.mock.invocationCallOrder[s.invoke.mock.calls.findIndex((call) => call[1] === 'create')];
    const getAt = s.invoke.mock.invocationCallOrder[s.invoke.mock.calls.findIndex((call) => call[1] === 'get')];
    expect(createAt).toBeLessThan(getAt);
    expect(s.scheduler.pause.mock.invocationCallOrder[0]).toBeGreaterThan(getAt);
  });

  it('does not create again when the receipt is unknown and no new copy is found', async () => {
    let creates = 0;
    const s = setup({
      create: async () => {
        creates += 1;
        return { ok: false, code: 'REMOTE_RESULT_UNKNOWN', message: 'unknown' };
      },
    });
    const result = parse(await s.registry.call('schedule_move', { id: 'src', targetDevice: 'spark' }));
    expect(result).toMatchObject({ ok: false, code: 'REMOTE_RESULT_UNKNOWN', sourceUntouched: true, queryBeforeRetry: true });
    expect(creates).toBe(1);
    expect(s.scheduler.pause).not.toHaveBeenCalled();
  });

  it('adopts the single new copy after an unknown receipt instead of creating twice', async () => {
    const s = setup({
      create: async () => {
        const row = {
          id: 'dst',
          name: source.name,
          prompt: source.prompt,
          cronExpr: source.cronExpr,
          timezone: source.timezone,
          agentKind: 'pi',
          model: 'grok-4.6',
          providerId: 'xai-2fdb5bc7',
          recurring: true,
          manual: false,
          useWorktree: false,
          workspaceKind: 'dialogue',
          persistentSession: false,
          silentWhenIdle: false,
          notify: { desktop: true, feishu: false },
          status: 'active',
        };
        s.remoteRows.set('dst', row);
        return { ok: false, code: 'REMOTE_TIMEOUT', message: 'timeout' };
      },
    });
    const result = parse(await s.registry.call('schedule_move', { id: 'src', targetDevice: 'spark' }));
    expect(result).toMatchObject({ ok: true, targetId: 'dst' });
    expect(s.invoke.mock.calls.filter((call) => call[1] === 'create')).toHaveLength(1);
    expect(s.scheduler.pause).toHaveBeenCalledWith('src');
  });

  it('does not pause the target when a lost source receipt already paused the source', async () => {
    const s = setup();
    let sourceReads = 0;
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'list') return { ok: true, data: [...s.remoteRows.values()] };
      if (op === 'get' && args[0] === 'src') {
        sourceReads += 1;
        return { ok: true, data: { ...source, status: sourceReads > 1 ? 'paused' : 'active' } };
      }
      if (op === 'get') return { ok: true, data: s.remoteRows.get(String(args[0])) ?? null };
      if (op === 'create') {
        const row = { ...(args[0] as object), id: 'dst', status: 'active' };
        s.remoteRows.set('dst', row);
        return { ok: true, data: row };
      }
      if (op === 'pause' && args[0] === 'src') return { ok: false, code: 'REMOTE_RESULT_UNKNOWN', message: 'unknown' };
      if (op === 'pause') return { ok: true, data: null };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const result = parse(await s.registry.call('schedule_move', { id: 'src', sourceDevice: 'mac', targetDevice: 'spark' }));
    expect(result.ok).toBe(true);
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause' && call[2][0] === 'dst')).toBe(false);
  });

  it('does not pause an adopted target when verification cannot be read', async () => {
    const s = setup();
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'get' && args[0] === 'src') return { ok: true, data: source };
      if (op === 'get') return { ok: false, code: 'REMOTE_TIMEOUT', message: 'timeout' };
      if (op === 'pause') return { ok: true, data: null };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const result = parse(await s.registry.call('schedule_move', {
      id: 'src', sourceDevice: 'mac', targetDevice: 'spark', adoptTargetId: 'already-there',
    }));
    expect(result).toMatchObject({ ok: false, sourceUntouched: true, targetPaused: false, targetId: 'already-there' });
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause')).toBe(false);
  });

  it('remaps a remote provider id against the local catalog when moving home', async () => {
    const s = setup();
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'get') return { ok: true, data: { ...source, providerId: 'remote-xai' } };
      if (op === 'pause') return { ok: true, data: { id: args[0], status: 'paused' } };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    s.scheduler.create.mockImplementation(async (input: Record<string, unknown>) => ({ ...input, id: 'home', status: 'active' }));
    s.scheduler.get.mockImplementation(async (id: string) => id === 'home'
      ? { ...(s.scheduler.create.mock.calls[0][0] as object), id: 'home', status: 'active' }
      : null);
    const result = parse(await s.registry.call('schedule_move', { id: 'src', sourceDevice: 'mac', targetDevice: 'local' }));
    expect(result.ok).toBe(true);
    expect(s.deps.listModels).toHaveBeenCalledWith({ agent: 'pi', agentDeviceId: null });
    expect(s.scheduler.create.mock.calls[0][0]).toMatchObject({ providerId: 'xai-2fdb5bc7' });
  });

  it('pauses a newly created target when verification cannot be read', async () => {
    const s = setup();
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'get' && args[0] === 'src') return { ok: true, data: source };
      if (op === 'list') return { ok: true, data: [] };
      if (op === 'create') return { ok: true, data: { id: 'dst', name: source.name, status: 'active' } };
      if (op === 'get') return { ok: false, code: 'REMOTE_TIMEOUT', message: 'timeout' };
      if (op === 'pause') return { ok: true, data: null };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const result = parse(await s.registry.call('schedule_move', {
      id: 'src', sourceDevice: 'mac', targetDevice: 'spark',
    }));
    expect(result).toMatchObject({ ok: false, sourceUntouched: true, targetPaused: true, targetId: 'dst' });
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause' && call[2][0] === 'dst')).toBe(true);
    expect(s.invoke.mock.calls.filter((call) => call[1] === 'create')).toHaveLength(1);
  });

  it('pauses a newly created target that does not match the moved definition', async () => {
    const s = setup();
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'get' && args[0] === 'src') return { ok: true, data: source };
      if (op === 'list') return { ok: true, data: [] };
      if (op === 'create') {
        const row = { ...(args[0] as object), id: 'dst', status: 'active', effort: 'low' };
        s.remoteRows.set('dst', row);
        return { ok: true, data: row };
      }
      if (op === 'get') return { ok: true, data: s.remoteRows.get(String(args[0])) ?? null };
      if (op === 'pause') return { ok: true, data: null };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const result = parse(await s.registry.call('schedule_move', {
      id: 'src', sourceDevice: 'mac', targetDevice: 'spark',
    }));
    expect(result).toMatchObject({ ok: false, sourceUntouched: true, targetPaused: true, targetId: 'dst' });
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause' && call[2][0] === 'dst')).toBe(true);
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause' && call[2][0] === 'src')).toBe(false);
  });

  it('copies execution fields and rejects an adopted target that differs', async () => {
    const s = setup();
    const defined = {
      ...source,
      modelAgentDeviceId: 'model-host',
      effort: 'high',
      fastMode: 'ultrafast' as const,
      expireAt: 1_700_000_000_000,
      notify: { desktop: true, feishu: false, wecomGroup: true },
    };
    s.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
      if (op === 'get' && args[0] === 'src') return { ok: true, data: defined };
      if (op === 'list') return { ok: true, data: [] };
      if (op === 'create') {
        const row = { ...(args[0] as object), id: 'dst', status: 'active' };
        s.remoteRows.set('dst', row);
        return { ok: true, data: row };
      }
      if (op === 'get') return { ok: true, data: s.remoteRows.get(String(args[0])) ?? null };
      if (op === 'pause' && args[0] === 'src') return { ok: true, data: { id: 'src', status: 'paused' } };
      return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
    });
    const moved = parse(await s.registry.call('schedule_move', {
      id: 'src', sourceDevice: 'mac', targetDevice: 'spark',
    }));
    expect(moved.ok).toBe(true);
    expect(s.invoke.mock.calls.find((call) => call[1] === 'create')?.[2][0]).toMatchObject({
      modelAgentDeviceId: 'model-host',
      effort: 'high',
      fastMode: 'ultrafast',
      expireAt: 1_700_000_000_000,
      notify: { desktop: true, feishu: false, wecomGroup: true },
    });

    const differences = [
      { effort: 'low' },
      { fastMode: false },
      { expireAt: 99 },
      { modelAgentDeviceId: 'other-host' },
      { notify: { desktop: false, feishu: false, wecomGroup: true } },
      { notify: { desktop: true, feishu: false, wecomGroup: false } },
    ];
    for (const difference of differences) {
      const rejected = setup();
      rejected.invoke.mockImplementation(async (_deviceId: string, op: string, args: unknown[]) => {
        if (op === 'get' && args[0] === 'src') return { ok: true, data: defined };
        if (op === 'get') {
          return {
            ok: true,
            data: {
              id: 'already-there',
              name: defined.name,
              prompt: defined.prompt,
              kind: 'cron',
              cronExpr: defined.cronExpr,
              timezone: defined.timezone,
              recurring: true,
              manual: false,
              agentKind: 'pi',
              model: 'grok-4.6',
              providerId: 'xai-2fdb5bc7',
              modelAgentDeviceId: 'model-host',
              effort: 'high',
              fastMode: 'ultrafast',
              expireAt: 1_700_000_000_000,
              useWorktree: false,
              workspaceKind: 'dialogue',
              persistentSession: false,
              silentWhenIdle: false,
              notify: { desktop: true, feishu: false, wecomGroup: true },
              status: 'active',
              ...difference,
            },
          };
        }
        if (op === 'pause') return { ok: true, data: null };
        return { ok: false, code: 'REMOTE_UNSUPPORTED', message: op };
      });
      const result = parse(await rejected.registry.call('schedule_move', {
        id: 'src', sourceDevice: 'mac', targetDevice: 'spark', adoptTargetId: 'already-there',
      }));
      expect(result).toMatchObject({ ok: false, sourceUntouched: true, targetPaused: false, targetId: 'already-there' });
      expect(rejected.invoke.mock.calls.some((call) => call[1] === 'pause' || call[1] === 'create')).toBe(false);
    }
  });

  it('pauses the target copy if stopping the source fails', async () => {
    const s = setup();
    s.scheduler.pause.mockRejectedValueOnce(new Error('source busy'));
    const result = parse(await s.registry.call('schedule_move', { id: 'src', targetDevice: 'spark' }));
    expect(result.ok).toBe(false);
    expect(result.targetPaused).toBe(true);
    expect(s.invoke.mock.calls.some((call) => call[1] === 'pause' && call[2][0] === 'dst')).toBe(true);
    expect(s.invoke.mock.calls.filter((call) => call[1] === 'create')).toHaveLength(1);
  });
});
