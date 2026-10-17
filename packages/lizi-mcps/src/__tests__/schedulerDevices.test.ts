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
  registerScheduleDeleteTool,
  registerScheduleGetTool,
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
      { model: null },
      { cronExpr: "not a cron" },
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
