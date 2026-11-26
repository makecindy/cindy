/**
 * usageDeviceRows — 用量历史跨设备合并的 wire 契约与被控端读取。
 *
 * 设置 → 用量历史默认合并同账号所有电脑的用量。每台电脑的真相只在它自己的
 * daily_spend / daily_model_usage 里,控制端经 device-link 调用
 * `maker:usage:device-rows` 拉取**原始行**(不是聚合后的 payload),在本机与
 * 自己的行合并后重新聚合 —— streak / 订阅估算 / 币种折叠全部沿用本机同一条链路,
 * 不需要拼接两份已聚合的结果。
 *
 * 请求:`[{ sinceDay?: 'YYYY-MM-DD' }]`。给出 sinceDay 时只回该日(含)之后的行,
 * 控制端据此增量同步;缺省回全部历史。
 * 响应:`{ format: 'usage-device-rows-v1', todayKey, sinceDay, rowsGz }`,
 * rowsGz = gzip(JSON({ spendDays, modelRows })) 的 base64 —— 新 channel 两端同代次,
 * 控制端恒可解 gzip(同 git-review:remote-op 的超帧预判口径);压缩后仍超预算回
 * `{ format, oversize: true }`,不裸炸 FRAME_TOO_LARGE。
 * 老被控端没有该 channel → CHANNEL_NOT_ALLOWED,控制端标记「版本过旧」。
 */

import { randomUUID } from 'node:crypto';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';

import { normalizeRegionalMoney, type RegionalMoney } from '../../shared/regionalMoney.js';
import type { DailyModelUsageRow } from '../localDb/dailyModelUsage.js';
import type { DailySessionUsageRow, UsageTaskMeta } from '../localDb/dailySessionUsage.js';

const gzipAsync = promisify(gzipCb);
const gunzipAsync = promisify(gunzipCb);

export const USAGE_DEVICE_ROWS_FORMAT = 'usage-device-rows-v1';
/** relay 单帧 2MiB;留出信封与 base64 膨胀余量。 */
const MAX_ROWS_GZ_BASE64_BYTES = 1_500_000;
/** 解压后上限:防止损坏或恶意回复在控制端撑爆内存。 */
const MAX_ROWS_JSON_BYTES = 32 * 1024 * 1024;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UsageSpendDayRow {
  day: string;
  monies: RegionalMoney[];
}

export interface UsageDeviceRows {
  spendDays: UsageSpendDayRow[];
  modelRows: DailyModelUsageRow[];
  /** 每日 × 任务 token(「最耗 token 的任务」按范围统计用)。 */
  sessionRows: DailySessionUsageRow[];
  /** sessionRows 涉及任务的元数据(标题 / 模型等取任务当前值)。 */
  tasks: UsageTaskMeta[];
}

export interface UsageTaskDelta {
  removedTaskIds: string[];
}

export interface UsageTaskDeltaCache {
  encode(
    scopeKey: string,
    requestedBase: string | null | undefined,
    visibleTasks: readonly UsageTaskMeta[],
  ): {
    tasks: UsageTaskMeta[];
    tasksToken: string;
    tasksDelta?: UsageTaskDelta;
  };
}

export type UsageDeviceRowsResponse =
  | {
      format: typeof USAGE_DEVICE_ROWS_FORMAT;
      todayKey: string;
      sinceDay: string | null;
      rowsGz: string;
      tasksToken?: string;
      tasksDelta?: UsageTaskDelta;
    }
  | { format: typeof USAGE_DEVICE_ROWS_FORMAT; oversize: true };

export interface UsageDeviceRowsReaderDeps {
  getAllSpendDays(): Promise<UsageSpendDayRow[]>;
  getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]>;
  getSessionUsageSince(
    sinceDayKey: string,
  ): Promise<{ rows: DailySessionUsageRow[]; tasks: UsageTaskMeta[] }>;
  /**
   * 远端可见的任务 id。任务标题等元数据要离开本机,必须经过与会话列表相同的
   * 远端 Bot 可见性边界(隐藏 / 已停用伙伴的任务不外发)。
   */
  remoteVisibleTaskIds(sessionIds: readonly string[]): Promise<ReadonlySet<string>>;
  todayKey(): string;
  taskDeltaCache?: UsageTaskDeltaCache;
  scopeKey?(): string;
}

const MAX_TASK_DELTA_SNAPSHOTS = 16;

function isTaskBaseToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/**
 * 被控端任务元数据增量基准缓存(按账号 scope 严格隔离,有界 LRU):
 * 新控制端带 `tasksBase` 时只回变更/新增的任务元数据与已移除 id,避免每分钟增量同步重传数千条未改动的历史任务元数据;
 * 旧控制端不带 `tasksBase`,或重启/淘汰未命中时回完整集合,保持双向无损兼容。
 */
export function createUsageTaskDeltaCache(maxSnapshots = MAX_TASK_DELTA_SNAPSHOTS): UsageTaskDeltaCache {
  const limit = Math.max(1, maxSnapshots);
  const entries = new Map<string, { scopeKey: string; token: string; byId: Map<string, string> }>();

  return {
    encode(scopeKey, requestedBase, visibleTasks) {
      const currentById = new Map<string, string>();
      for (const task of visibleTasks) {
        currentById.set(task.sessionId, JSON.stringify(task));
      }
      let latest: { scopeKey: string; token: string; byId: Map<string, string> } | undefined;
      for (const entry of entries.values()) {
        if (entry.scopeKey === scopeKey) latest = entry;
      }
      let token: string;
      let storedById: Map<string, string>;
      if (
        latest &&
        latest.byId.size === currentById.size &&
        [...currentById.entries()].every(([id, serialized]) => latest.byId.get(id) === serialized)
      ) {
        token = latest.token;
        storedById = latest.byId;
      } else {
        token = randomUUID();
        storedById = currentById;
      }
      const baseKey = isTaskBaseToken(requestedBase) ? `${scopeKey}\u0000${requestedBase}` : null;
      const base = baseKey ? entries.get(baseKey) : undefined;
      const currentKey = `${scopeKey}\u0000${token}`;
      entries.delete(currentKey);
      entries.set(currentKey, { scopeKey, token, byId: storedById });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      if (!base) {
        return { tasks: [...visibleTasks], tasksToken: token };
      }
      if (base.token === token) {
        return { tasks: [], tasksToken: token, tasksDelta: { removedTaskIds: [] } };
      }
      const tasks = visibleTasks.filter(
        (task) => base.byId.get(task.sessionId) !== currentById.get(task.sessionId),
      );
      const removedTaskIds = [...base.byId.keys()].filter((id) => !currentById.has(id));
      return { tasks, tasksToken: token, tasksDelta: { removedTaskIds } };
    },
  };
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_RE.test(value);
}

export interface UsageDeviceRowsRequest {
  sinceDay: string | null;
  tasksBase?: string | null;
}

/** 解析被控端请求参数;非法时返回 null(由 IPC handler 转成 INVALID_PARAMS)。 */
export function parseUsageDeviceRowsRequest(arg: unknown): UsageDeviceRowsRequest | null {
  if (arg === undefined || arg === null) return { sinceDay: null };
  if (typeof arg !== 'object' || Array.isArray(arg)) return null;
  const raw = arg as { sinceDay?: unknown; tasksBase?: unknown };
  const sinceDay = raw.sinceDay;
  if (sinceDay !== undefined && sinceDay !== null && !isDayKey(sinceDay)) return null;
  const tasksBase = isTaskBaseToken(raw.tasksBase) ? raw.tasksBase : undefined;
  return {
    sinceDay: sinceDay ?? null,
    ...(tasksBase ? { tasksBase } : {}),
  };
}

/** 被控端:读本机原始用量行并编码成 wire 响应。 */
export async function readUsageDeviceRows(
  deps: UsageDeviceRowsReaderDeps,
  request: UsageDeviceRowsRequest,
): Promise<UsageDeviceRowsResponse> {
  const todayKey = deps.todayKey();
  const sinceDay = request.sinceDay;
  const [spendDays, modelRows, sessionUsage] = await Promise.all([
    deps.getAllSpendDays(),
    deps.getModelUsageSince(sinceDay ?? '0000-01-01'),
    deps.getSessionUsageSince(sinceDay ?? '0000-01-01'),
  ]);
  const visible = await deps.remoteVisibleTaskIds(sessionUsage.tasks.map((task) => task.sessionId));
  const visibleTasks = sessionUsage.tasks.filter((task) => visible.has(task.sessionId));
  const encodedTasks = deps.taskDeltaCache
    ? deps.taskDeltaCache.encode(
        deps.scopeKey?.() ?? 'default',
        sinceDay ? request.tasksBase : null,
        visibleTasks,
      )
    : { tasks: visibleTasks, tasksToken: undefined, tasksDelta: undefined };
  const rows: UsageDeviceRows = {
    spendDays: sinceDay ? spendDays.filter((row) => row.day >= sinceDay) : spendDays,
    modelRows,
    sessionRows: sessionUsage.rows.filter((row) => visible.has(row.sessionId)),
    tasks: encodedTasks.tasks,
  };
  const rowsGz = (await gzipAsync(Buffer.from(JSON.stringify(rows), 'utf8'))).toString('base64');
  if (Buffer.byteLength(rowsGz, 'utf8') > MAX_ROWS_GZ_BASE64_BYTES) {
    return { format: USAGE_DEVICE_ROWS_FORMAT, oversize: true };
  }
  return {
    format: USAGE_DEVICE_ROWS_FORMAT,
    todayKey,
    sinceDay,
    rowsGz,
    ...(encodedTasks.tasksToken ? { tasksToken: encodedTasks.tasksToken } : {}),
    ...(encodedTasks.tasksDelta ? { tasksDelta: encodedTasks.tasksDelta } : {}),
  };
}

/** JavaScript Date 能表示的最大 Unix 毫秒;超出时 toISOString / Intl 格式化会抛 RangeError。 */
const MAX_DATE_MS = 8.64e15;

/** 跨设备 / 磁盘来的时间戳:只接受 Date 能表示的正 Unix 毫秒。 */
export function isUnixMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isAgentKind(value: unknown): value is DailyModelUsageRow['agentKind'] {
  return (
    value === 'claude-code' ||
    value === 'codex' ||
    value === 'pi' ||
    value === 'acp' ||
    value === 'media' ||
    value === 'auxiliary'
  );
}

/** 控制端和缓存共用的逐行校验:远端 / 磁盘数据一律当不可信输入。 */
export function sanitizeUsageDeviceRows(value: unknown): UsageDeviceRows | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as {
    spendDays?: unknown;
    modelRows?: unknown;
    sessionRows?: unknown;
    tasks?: unknown;
  };
  if (!Array.isArray(raw.spendDays) || !Array.isArray(raw.modelRows)) return null;
  const spendDays: UsageSpendDayRow[] = [];
  for (const row of raw.spendDays as Array<{ day?: unknown; monies?: unknown }>) {
    if (!row || !isDayKey(row.day) || !Array.isArray(row.monies)) continue;
    const monies = row.monies
      .map((money) => normalizeRegionalMoney(money))
      .filter((money): money is RegionalMoney => Boolean(money && money.amount > 0));
    if (monies.length > 0) spendDays.push({ day: row.day, monies });
  }
  const modelRows: DailyModelUsageRow[] = [];
  for (const row of raw.modelRows as Array<Partial<DailyModelUsageRow>>) {
    if (!row || !isDayKey(row.day) || !isAgentKind(row.agentKind)) continue;
    if (typeof row.model !== 'string' || row.model.length === 0 || row.model.length > 256) continue;
    const money = normalizeRegionalMoney(row.money);
    if (!money) continue;
    modelRows.push({
      day: row.day,
      agentKind: row.agentKind,
      ...(row.requestCount !== undefined
        ? { requestCount: finiteNonNegative(row.requestCount) }
        : {}),
      ...(isShortString(row.source) ? { source: row.source } : {}),
      ...(isShortString(row.providerId) ? { providerId: row.providerId } : {}),
      model: row.model,
      money,
      inputTokens: finiteNonNegative(row.inputTokens),
      outputTokens: finiteNonNegative(row.outputTokens),
      cacheReadTokens: finiteNonNegative(row.cacheReadTokens),
      cacheCreateTokens: finiteNonNegative(row.cacheCreateTokens),
    });
  }
  const sessionRows: DailySessionUsageRow[] = [];
  for (const row of (Array.isArray(raw.sessionRows) ? raw.sessionRows : []) as Array<
    Partial<DailySessionUsageRow>
  >) {
    if (!row || !isDayKey(row.day) || !isShortString(row.sessionId)) continue;
    const tokens = finiteNonNegative(row.tokens);
    if (tokens > 0) sessionRows.push({ day: row.day, sessionId: row.sessionId, tokens,
      ...(row.auxiliaryTokens !== undefined ? { auxiliaryTokens: Math.min(tokens, finiteNonNegative(row.auxiliaryTokens)) } : {}),
    });
  }
  const tasks: UsageTaskMeta[] = [];
  for (const task of (Array.isArray(raw.tasks) ? raw.tasks : []) as Array<Partial<UsageTaskMeta>>) {
    if (!task || !isShortString(task.sessionId)) continue;
    tasks.push({
      sessionId: task.sessionId,
      title: typeof task.title === 'string' ? task.title.slice(0, 500) : '',
      model: typeof task.model === 'string' ? task.model.slice(0, 256) : '',
      providerId: isShortString(task.providerId) ? task.providerId : null,
      source: isShortString(task.source) ? task.source : null,
      contextTokens: finiteNonNegative(task.contextTokens),
      contextWindow: finiteNonNegative(task.contextWindow),
      lastActiveAt: isUnixMs(task.lastActiveAt) ? task.lastActiveAt : 0,
    });
  }
  return { spendDays, modelRows, sessionRows, tasks };
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** 控制端:解码并校验 wire 响应。oversize 返回 'oversize';格式不对返回 null。 */
export async function decodeUsageDeviceRowsResponse(
  value: unknown,
): Promise<
  | {
      kind: 'rows';
      todayKey: string;
      sinceDay: string | null;
      rows: UsageDeviceRows;
      tasksToken?: string;
      tasksDelta?: UsageTaskDelta;
    }
  | { kind: 'oversize' }
  | null
> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (response.format !== USAGE_DEVICE_ROWS_FORMAT) return null;
  if (response.oversize === true) return { kind: 'oversize' };
  if (!isDayKey(response.todayKey) || typeof response.rowsGz !== 'string') return null;
  const sinceDay = response.sinceDay === null ? null : response.sinceDay;
  if (sinceDay !== null && !isDayKey(sinceDay)) return null;
  const tasksToken = isTaskBaseToken(response.tasksToken) ? response.tasksToken : undefined;
  let tasksDelta: UsageTaskDelta | undefined;
  if (response.tasksDelta && typeof response.tasksDelta === 'object' && !Array.isArray(response.tasksDelta)) {
    const rawRemoved = (response.tasksDelta as { removedTaskIds?: unknown }).removedTaskIds;
    if (Array.isArray(rawRemoved)) {
      tasksDelta = { removedTaskIds: rawRemoved.filter(isShortString) };
    }
  }
  try {
    const json = await gunzipAsync(Buffer.from(response.rowsGz, 'base64'), {
      maxOutputLength: MAX_ROWS_JSON_BYTES,
    });
    const rows = sanitizeUsageDeviceRows(JSON.parse(json.toString('utf8')));
    return rows
      ? {
          kind: 'rows',
          todayKey: response.todayKey,
          sinceDay,
          rows,
          ...(tasksToken ? { tasksToken } : {}),
          ...(tasksDelta ? { tasksDelta } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
