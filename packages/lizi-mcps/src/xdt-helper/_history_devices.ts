import { z } from "zod";
import type {
  XdtHelperToolRegistry,
  XdtHelperToolResult,
} from "../lizi_xdtHelperToolRegistry.js";
import type { LiziMcpSessionContext } from "../types.js";
import type { XdtHelperHistoryDeps } from "./_history_types.js";
import { resolveHistoryScope } from "./_history_scope.js";
import { errorPayload, okPayload } from "./_payload.js";

export type HistoryQueryTool = "list_sessions" | "search_chat_history";
export interface HistoryDevice {
  deviceId: string;
  deviceName: string;
  local: boolean;
  available: boolean;
  unavailableReason?: string;
}
export interface HistoryRemoteDeps {
  captureAccess(): () => void;
  listDevices(): Promise<HistoryDevice[]>;
  query(
    deviceId: string,
    tool: HistoryQueryTool,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export const historyDeviceShape = {
  device: z
    .string()
    .min(1)
    .max(256)
    .default("local")
    .describe(
      "local (default), all (local + online authorized computers), or exact deviceId from list_history_devices. Cross-device results are grouped by device; limit applies per device. Continue each group with its deviceId and nextCursor.",
    ),
};
export const HISTORY_DEVICE_DESCRIPTION =
  'Use device="all" to discover/query local and online authorized computers, or list_history_devices then device=<exact id>. Results are grouped per device, with independent nextCursor values; paginate each device separately. Unavailable devices and partial coverage are explicit. Remote session IDs can be passed directly to get_chat_history. Local-only remains the default.';

export function historyPayload(
  result: XdtHelperToolResult,
): Record<string, unknown> {
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text")
    throw new Error("Invalid history response");
  const value: unknown = JSON.parse(block.text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid history response");
  return value as Record<string, unknown>;
}

/** Qualify only Session identities; source-local cursors and message IDs stay opaque. */
export function qualifyHistoryPayload(
  value: Record<string, unknown>,
  deviceId: string,
): Record<string, unknown> {
  if (value.ok !== true) return value;
  const qualify = (id: string) => `${deviceId}::${id}`;
  if (Array.isArray(value.sessions)) {
    return {
      ...value,
      sessions: value.sessions.map((s: Record<string, unknown>) => ({
        ...s,
        id: qualify(String(s.id)),
        ...(typeof s.parentSessionId === "string"
          ? { parentSessionId: qualify(s.parentSessionId) }
          : {}),
      })),
    };
  }
  const sessions = value.sessions as Record<string, unknown> | undefined;
  return {
    ...value,
    ...(sessions
      ? {
          sessions: Object.fromEntries(
            Object.entries(sessions).map(([id, meta]) => [qualify(id), meta]),
          ),
        }
      : {}),
    ...(Array.isArray(value.hits)
      ? {
          hits: value.hits.map((h: Record<string, unknown>) => ({
            ...h,
            sessionId: qualify(String(h.sessionId)),
            context: (h.context as Record<string, unknown>[]).map((c) => ({
              ...c,
              sessionId: qualify(String(c.sessionId)),
            })),
          })),
        }
      : {}),
  };
}

export interface HistoryDeviceToolDeps {
  history: XdtHelperHistoryDeps;
  getSessionContext?: () => LiziMcpSessionContext | undefined;
}

export function registerHistoryDevicesTool(
  registry: XdtHelperToolRegistry,
  deps: HistoryDeviceToolDeps,
): void {
  registry.register({
    name: "list_history_devices",
    category: "history",
    description:
      "Discover computers for history queries. Returns exact device IDs, names, availability and reasons for unavailable devices. Does not enable remote access or read offline caches. Ownership-scoped callers cannot expand their history access.",
    inputShape: {},
    handler: async () => {
      const assertCurrent = deps.history.remote?.captureAccess();
      const scope = await resolveHistoryScope(
        deps.history,
        deps.getSessionContext,
        null,
      );
      assertCurrent?.();
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.sessionIds !== null)
        return errorPayload(
          "HISTORY_SCOPE_DENIED",
          "当前伙伴只能查询自己的本机历史。",
        );
      if (!deps.history.remote)
        return errorPayload(
          "REMOTE_UNSUPPORTED",
          "当前宿主不支持跨设备历史发现。",
        );
      try {
        const devices = await deps.history.remote.listDevices();
        assertCurrent?.();
        return okPayload({ devices });
      } catch {
        return errorPayload(
          "DEVICE_DISCOVERY_FAILED",
          "无法取得设备列表，请稍后重试。",
        );
      }
    },
  });
}

/** Reuses the same local tool handler on both hosts, without a second query/formatting implementation. */
export async function queryHistoryDevices(
  registry: XdtHelperToolRegistry,
  deps: HistoryDeviceToolDeps,
  tool: HistoryQueryTool,
  args: Record<string, unknown> & { device: string },
): Promise<XdtHelperToolResult> {
  const assertCurrent = deps.history.remote?.captureAccess() ?? (() => {});
  const scope = await resolveHistoryScope(
    deps.history,
    deps.getSessionContext,
    null,
  );
  assertCurrent();
  if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
  if (scope.sessionIds !== null)
    return errorPayload(
      "HISTORY_SCOPE_DENIED",
      "当前伙伴只能查询自己的本机历史。",
    );
  if (!deps.history.remote)
    return errorPayload("REMOTE_UNSUPPORTED", "当前宿主不支持跨设备历史查询。");
  if (args.device === "all" && args.cursor)
    return errorPayload(
      "INVALID_ARGS",
      "跨设备翻页请使用对应组的 deviceId 和 nextCursor。",
    );
  // Qualified IDs must be routed to exactly their source. Never search a same-named local ID.
  const requested = args.session_ids as string[] | undefined;
  if (args.device === "all" && requested?.length)
    return errorPayload(
      "INVALID_ARGS",
      "指定 session_ids 时请同时指定单台 device。",
    );
  if (
    requested?.some((id) => id.includes("::")) &&
    (args.device === "all" ||
      requested.some((id) => !id.startsWith(`${args.device}::`)))
  ) {
    return errorPayload(
      "INVALID_ARGS",
      "带设备前缀的 session_ids 必须全部属于指定 device。",
    );
  }
  let devices: HistoryDevice[];
  let discoveryFailed = false;
  try {
    devices = await deps.history.remote.listDevices();
  } catch {
    if (args.device !== "all")
      return errorPayload(
        "DEVICE_DISCOVERY_FAILED",
        "无法取得设备列表，请稍后重试。",
      );
    discoveryFailed = true;
    devices = [
      { deviceId: "local", deviceName: "Local", local: true, available: true },
    ];
  }
  const targets =
    args.device === "all"
      ? devices
      : devices.filter((d) => d.deviceId === args.device);
  assertCurrent();
  if (!targets.length)
    return errorPayload("NOT_FOUND", "设备不在当前账号的可访问设备列表中。");
  const groups: Record<string, unknown>[] = [];
  // Small bounded batches, no persistent state, background retries or new connections outside existing policy.
  for (let start = 0; start < targets.length; start += 3) {
    groups.push(
      ...(await Promise.all(
        targets.slice(start, start + 3).map(async (device) => {
          if (!device.available)
            return {
              ...device,
              ok: false,
              errorCode: device.unavailableReason,
            };
          const queryArgs = {
            ...args,
            device: "local",
            ...(requested
              ? {
                  session_ids: requested.map((id) =>
                    id.startsWith(`${device.deviceId}::`)
                      ? id.slice(device.deviceId.length + 2)
                      : id,
                  ),
                }
              : {}),
          };
          try {
            assertCurrent();
            const result = device.local
              ? historyPayload(await registry.call(tool, queryArgs))
              : qualifyHistoryPayload(
                  await deps.history.remote!.query(
                    device.deviceId,
                    tool,
                    queryArgs,
                  ),
                  device.deviceId,
                );
            assertCurrent();
            return { ...result, ...device };
          } catch {
            return { ...device, ok: false, errorCode: "REMOTE_UNAVAILABLE" };
          }
        }),
      )),
    );
  }
  assertCurrent();
  return okPayload({
    groups,
    partial: discoveryFailed || groups.some((group) => group.ok !== true),
    ...(discoveryFailed ? { discoveryError: "DEVICE_DISCOVERY_FAILED" } : {}),
    hasMore: groups.some((group) => group.hasMore === true),
    pagination:
      "Continue each successful group using device=<deviceId> and cursor=<nextCursor>, preserving query filters. Scores are comparable only within a device.",
  });
}
