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

export type UsageDeviceRowsResponse =
  | {
      format: typeof USAGE_DEVICE_ROWS_FORMAT;
      todayKey: string;
      sinceDay: string | null;
      rowsGz: string;
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
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_RE.test(value);
}

/** 解析被控端请求参数;非法时返回 null(由 IPC handler 转成 INVALID_PARAMS)。 */
export function parseUsageDeviceRowsRequest(arg: unknown): { sinceDay: string | null } | null {
  if (arg === undefined || arg === null) return { sinceDay: null };
  if (typeof arg !== 'object' || Array.isArray(arg)) return null;
  const sinceDay = (arg as { sinceDay?: unknown }).sinceDay;
  if (sinceDay === undefined || sinceDay === null) return { sinceDay: null };
  return isDayKey(sinceDay) ? { sinceDay } : null;
}

/** 被控端:读本机原始用量行并编码成 wire 响应。 */
export async function readUsageDeviceRows(
  deps: UsageDeviceRowsReaderDeps,
  request: { sinceDay: string | null },
): Promise<UsageDeviceRowsResponse> {
  const todayKey = deps.todayKey();
  const sinceDay = request.sinceDay;
  const [spendDays, modelRows, sessionUsage] = await Promise.all([
    deps.getAllSpendDays(),
    deps.getModelUsageSince(sinceDay ?? '0000-01-01'),
    deps.getSessionUsageSince(sinceDay ?? '0000-01-01'),
  ]);
  const visible = await deps.remoteVisibleTaskIds(sessionUsage.tasks.map((task) => task.sessionId));
  const rows: UsageDeviceRows = {
    spendDays: sinceDay ? spendDays.filter((row) => row.day >= sinceDay) : spendDays,
    modelRows,
    sessionRows: sessionUsage.rows.filter((row) => visible.has(row.sessionId)),
    tasks: sessionUsage.tasks.filter((task) => visible.has(task.sessionId)),
  };
  const rowsGz = (await gzipAsync(Buffer.from(JSON.stringify(rows), 'utf8'))).toString('base64');
  if (Buffer.byteLength(rowsGz, 'utf8') > MAX_ROWS_GZ_BASE64_BYTES) {
    return { format: USAGE_DEVICE_ROWS_FORMAT, oversize: true };
  }
  return { format: USAGE_DEVICE_ROWS_FORMAT, todayKey, sinceDay, rowsGz };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isAgentKind(value: unknown): value is DailyModelUsageRow['agentKind'] {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
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
    if (tokens > 0) sessionRows.push({ day: row.day, sessionId: row.sessionId, tokens });
  }
  const tasks: UsageTaskMeta[] = [];
  for (const task of (Array.isArray(raw.tasks) ? raw.tasks : []) as Array<Partial<UsageTaskMeta>>) {
    if (!task || !isShortString(task.sessionId)) continue;
    tasks.push({
      sessionId: task.sessionId,
      title: typeof task.title === 'string' ? task.title.slice(0, 500) : '',
      model: typeof task.model === 'string' ? task.model.slice(0, 256) : '',
      providerId: isShortString(task.providerId) ? task.providerId : null,
      contextTokens: finiteNonNegative(task.contextTokens),
      contextWindow: finiteNonNegative(task.contextWindow),
      lastActiveAt: finiteNonNegative(task.lastActiveAt),
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
  | { kind: 'rows'; todayKey: string; sinceDay: string | null; rows: UsageDeviceRows }
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
  try {
    const json = await gunzipAsync(Buffer.from(response.rowsGz, 'base64'), {
      maxOutputLength: MAX_ROWS_JSON_BYTES,
    });
    const rows = sanitizeUsageDeviceRows(JSON.parse(json.toString('utf8')));
    return rows ? { kind: 'rows', todayKey: response.todayKey, sinceDay, rows } : null;
  } catch {
    return null;
  }
}
