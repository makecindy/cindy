/**
 * scheduler/_devices.ts — 定时任务工具的跨电脑路由。
 *
 * 定时任务保存在各自的电脑上。`device` 缺省 / "local" 走本机 Scheduler，行为与返回
 * 形状不变；指定电脑或 "all" 时经 host 注入的 `deps.remote` 调用对方电脑上已有的
 * `maker:schedule:*` 远程控制通道（与用户在远程控制里操作定时任务同一条通道与授权）。
 * 本层不重试、不缓存；连接由 host 的既有远程调用策略管理。
 */

import { z } from "zod";
import type { Scheduler } from "@cindy/maker-scheduler";

import type { SchedulerToolResult } from "../cindy_schedulerToolRegistry.js";
import type { SchedulerMcpDeps } from "../types.js";
import { buildJsonResult, withScheduler } from "./_shared.js";
import { classifySchedulerError } from "./errors.js";

export interface SchedulerDevice {
  deviceId: string;
  deviceName: string;
  local: boolean;
  available: boolean;
  unavailableReason?: string;
}

export type SchedulerRemoteOp =
  | "list"
  | "get"
  | "list-runs"
  | "update"
  | "pause"
  | "resume"
  | "delete"
  | "run-now";

export type SchedulerRemoteResult =
  { ok: true; data: unknown } | { ok: false; code: string; message: string };

/** Host-injected access to schedules on the user's other computers. */
export interface SchedulerRemoteDeps {
  /** Same-account computers; the local one has deviceId "local". */
  listDevices(): Promise<SchedulerDevice[]>;
  /** One request on one computer. Never throws; an older peer reports REMOTE_UNSUPPORTED. */
  invoke(
    deviceId: string,
    op: SchedulerRemoteOp,
    args: unknown[],
  ): Promise<SchedulerRemoteResult>;
}

const DEVICE_ID = z.string().min(1).max(256);

/** 读工具：本机、全部电脑或指定电脑。 */
export const readDeviceShape = {
  device: DEVICE_ID.optional().describe(
    'local（默认，仅本机）、all（本机 + 其它在线且已开启远程控制的电脑）或某台电脑的 deviceId（device="all" 的返回里有）。非 local 时结果按电脑分组。',
  ),
};

/** 写工具：本机或指定的一台电脑。 */
export const writeDeviceShape = {
  device: DEVICE_ID.optional().describe(
    "local（默认，本机）或目标定时任务所在电脑的 deviceId。schedule id 只在它所在的电脑上有效。",
  ),
};

/**
 * 其它电脑返回的定时任务 / 运行记录里，绑定任务 id 只在那台电脑上有效。与历史查询同一约定，
 * 加上 `deviceId::` 前缀，Agent 可直接交给 send_to_session / get_chat_history，
 * 写回 schedule_update 时再去掉。只改这两个字段，其余原样透传。
 */
export function qualifyRemoteSessionIds(
  data: unknown,
  deviceId: string,
): unknown {
  const qualifyRow = (row: unknown): unknown => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const record = { ...(row as Record<string, unknown>) };
    for (const key of ["targetSessionId", "sessionId"] as const) {
      const value = record[key];
      if (typeof value === "string" && value && !value.includes("::")) {
        record[key] = `${deviceId}::${value}`;
      }
    }
    return record;
  };
  return Array.isArray(data) ? data.map(qualifyRow) : qualifyRow(data);
}

export const isLocalDevice = (device: string | undefined): boolean =>
  !device || device === "local";

function failure(code: string, message: string): SchedulerToolResult {
  return buildJsonResult({ ok: false, code, message }, true);
}

/**
 * Run one operation where the schedule lives. `local` keeps the exact local result
 * shape; a remote computer returns the same `{ ok, data }` envelope plus its deviceId.
 */
export async function runOnDevice(
  deps: SchedulerMcpDeps,
  device: string | undefined,
  local: (scheduler: Scheduler) => Promise<unknown>,
  remote: {
    op: SchedulerRemoteOp;
    args: unknown[];
    map?: (data: unknown) => unknown;
  },
): Promise<SchedulerToolResult> {
  if (isLocalDevice(device)) return withScheduler(deps, local);
  if (device === "all") {
    return failure(
      "INVALID_PARAMS",
      "invalid device: 写操作一次只能作用于一台电脑，请传 local 或具体 deviceId",
    );
  }
  if (!deps.remote)
    return failure(
      "REMOTE_UNSUPPORTED",
      "当前宿主不支持操作其它电脑上的定时任务",
    );
  const result = await deps.remote.invoke(device!, remote.op, remote.args);
  if (!result.ok) return failure(result.code, result.message);
  return buildJsonResult({
    ok: true,
    deviceId: device,
    data: (remote.map ?? ((data: unknown) => data))(
      qualifyRemoteSessionIds(result.data, device!),
    ),
  });
}

/**
 * Read on this computer, one named computer, or every reachable one. Non-local
 * results are grouped per computer; unreachable computers stay in the list with a reason.
 */
export async function readOnDevices(
  deps: SchedulerMcpDeps,
  device: string | undefined,
  local: (scheduler: Scheduler) => Promise<unknown>,
  remote: {
    op: SchedulerRemoteOp;
    args: unknown[];
    map?: (data: unknown) => unknown;
  },
  localExtras: Record<string, unknown> = {},
): Promise<SchedulerToolResult> {
  const map = remote.map ?? ((data: unknown) => data);
  const readLocal = async (): Promise<SchedulerRemoteResult> => {
    try {
      return { ok: true, data: map(await local(deps.getScheduler())) };
    } catch (err) {
      return { ok: false, ...classifySchedulerError(err) };
    }
  };
  if (isLocalDevice(device)) {
    const result = await readLocal();
    // 本机读取一律自带范围:否则「本机没有」(如 get 的 data:null)会被读成哪台电脑都没有。
    return result.ok
      ? buildJsonResult({
          ok: true,
          data: result.data,
          scope: "local",
          ...localExtras,
        })
      : failure(result.code, result.message);
  }
  if (!deps.remote)
    return failure(
      "REMOTE_UNSUPPORTED",
      "当前宿主不支持查询其它电脑上的定时任务",
    );

  let devices: SchedulerDevice[];
  let discoveryFailed = false;
  try {
    devices = await deps.remote.listDevices();
  } catch {
    if (device !== "all")
      return failure("DEVICE_DISCOVERY_FAILED", "无法取得电脑列表，请稍后重试");
    discoveryFailed = true;
    devices = [
      { deviceId: "local", deviceName: "Local", local: true, available: true },
    ];
  }
  const targets =
    device === "all" ? devices : devices.filter((d) => d.deviceId === device);
  // 与「定时任务不存在」(NOT_FOUND) 区分开。
  if (!targets.length)
    return failure("DEVICE_NOT_FOUND", "这台电脑不在当前账号的电脑列表中");

  const groups: Record<string, unknown>[] = [];
  // Bounded fan-out, independent of how many computers the account has.
  for (let start = 0; start < targets.length; start += 3) {
    groups.push(
      ...(await Promise.all(
        targets.slice(start, start + 3).map(async (target) => {
          if (!target.available) {
            return {
              ...target,
              ok: false,
              code: target.unavailableReason ?? "REMOTE_UNAVAILABLE",
            };
          }
          const result = target.local
            ? await readLocal()
            : await deps
                .remote!.invoke(target.deviceId, remote.op, remote.args)
                .then(
                  (r) =>
                    r.ok
                      ? {
                          ok: true as const,
                          // 先加前缀再筛选：query 用 deviceId::sessionId 也能命中。
                          data: map(
                            qualifyRemoteSessionIds(r.data, target.deviceId),
                          ),
                        }
                      : r,
                  () => ({
                    ok: false as const,
                    code: "REMOTE_UNAVAILABLE",
                    message: "",
                  }),
                );
          return result.ok
            ? { ...target, ok: true, data: result.data }
            : {
                ...target,
                ok: false,
                code: result.code,
                ...(result.message ? { message: result.message } : {}),
              };
        }),
      )),
    );
  }
  return buildJsonResult({
    ok: true,
    groups,
    // partial = 至少一台电脑没查到；不能据此断言「所有电脑上都没有」。
    partial: discoveryFailed || groups.some((group) => group.ok !== true),
    ...(discoveryFailed ? { discoveryError: "DEVICE_DISCOVERY_FAILED" } : {}),
  });
}
