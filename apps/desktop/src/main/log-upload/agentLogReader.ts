/**
 * `agent-<date>.ndjson`（logs 根，**不是** `sessions/<id>/`）的读侧。
 *
 * 只在崩溃路径附带，且**只取 `source === 'proxy'` 的记录**：同一个文件里还有 `maker`
 * 源的启动期 / 全局基础设施日志，那些可能带 agent 提示词与用户内容。需求 §4.2 的措辞是
 * 「只取 proxy 的状态/耗时/错误，作崩溃上下文」。
 *
 * ⚠️ **「按字面执行」不能靠原样搬 `msg`**（2026-08-04 review P1）。proxy 自己会把请求体与
 * 上游错误体写进日志上下文：
 *
 *   - `logger.debug('▶ inbound request from client', { …, body: dumpBody(rawBody) })`
 *     —— `XDT_PROXY_DUMP_REQUEST_BODY=1` 时带**完整请求体**，对 anthropic-compat proxy
 *     就是整个 prompt（对话正文 + 被读进上下文的文件内容）；
 *   - `logger.warn('◀ upstream response (non-2xx)', { …, body: dumpBody(errBody) })`
 *     —— 只要 debug 等级开着就带上游错误体，而它发在 **warn** 级，光按等级过滤挡不住。
 *
 * 而 `logger.emit()` 是 `util.format(...args)`，上下文对象会被**渲染进 `msg`**。所以拿整条
 * `msg` 上报等于把这些 dump 一起带走。
 *
 * 因此 proxy 记录不走「整条正文 + 正则兜底」，而是**逐字段重建**：
 *   1. 等级闸：只放行 info 及以上，debug / trace 整条丢（请求体 dump 就在 debug）；
 *   2. 标记：取 `msg` 里渲染对象之前的那截字面量，截断到 `MAX_MARKER_CHARS`；
 *   3. 字段白名单：只按 `PROXY_FIELDS` 的窄正则取回状态码 / 字节数 / 耗时这类标量，
 *      `body` 这种不在名单里的键**根本没有出口**，与等级无关。
 *
 * 记录边界不需要哨兵：NDJSON 一行一条，边界由 JSON 行本身保证，不存在伪造记录头的问题。
 */

import type { LineTimestampParser } from './mainLogReader';
import { redact } from './redact';
import type { ParsedRecord } from './types';

export interface ParseAgentLogOptions {
  fromFileStart: boolean;
  homeDir?: string;
}

/**
 * NDJSON 流的时间戳解析器（供 `findOffsetAtOrBefore` 定位读取用）。
 *
 * 只取 `ts`（epoch ms），不做 JSON.parse 之外的解释：定位阶段只需要时间戳，字段白名单与
 * 脱敏在真正解析记录时（`parseAgentLogText`）才做。坏行 / 半行返回 null，让二分跳过它。
 */
export const parseNdjsonTimestamp: LineTimestampParser = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (!raw || typeof raw !== 'object') return null;
    const ts = (raw as Record<string, unknown>).ts;
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
};

export interface ParseAgentLogResult {
  records: ParsedRecord[];
  linesScanned: number;
  droppedBySource: number;
}

/**
 * proxy 的 scope 根。`cc-proxy` / `codex-proxy` 是 anthropic-compat-proxy-host 与
 * codex-proxy-host 的根 scope（见 logger.ts 的 `isCcProxyScope` / `isCodexProxyScope`）。
 *
 * 这里**不复用** `isAllowedScope`：那张表管的是 main 流的基础设施来源，proxy 不在其中
 * （proxy 日志不写 main 流）。所以 agent 流有自己的一条窄放行规则，同样是白名单方向。
 */
const PROXY_SCOPE_ROOTS: readonly string[] = ['cc-proxy', 'codex-proxy'];

function isProxyScope(scope: string): boolean {
  return PROXY_SCOPE_ROOTS.some(
    (root) => scope === root || scope.startsWith(`${root}/`) || scope.startsWith(`${root}:`),
  );
}

/**
 * 放行的等级。debug / trace 整条丢：proxy 的请求体 dump 就发在 debug，而调试级别本来也不是
 * 「状态/耗时/错误」这层需要的东西。
 */
const ALLOWED_LEVELS: readonly string[] = ['info', 'warn', 'error', 'fatal'];

/** 标记（渲染对象之前那截字面量）的长度上限。 */
const MAX_MARKER_CHARS = 80;

/**
 * 可以带出的标量字段。**这是第四层字段白名单在 proxy 记录内部的延伸**：值必须匹配这里给的
 * 窄形状才带出，不匹配就当没有；名单外的键（`body` / `prompt` / 任何将来新增的）没有出口。
 *
 * 形状写窄不是为了好看——用 `.*` 之类宽松模式取值，等于把「这个键的值安全」的判断让给了
 * 写日志的人。这里每条都限定字符集与长度。
 */
const PROXY_FIELDS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: 'reqId', pattern: /\breqId:\s*'([A-Za-z0-9_-]{1,64})'/ },
  { key: 'method', pattern: /\bmethod:\s*'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'/ },
  { key: 'status', pattern: /\bstatus:\s*(\d{3})\b/ },
  { key: 'bytes', pattern: /\bbytes:\s*(\d{1,12})\b/ },
  { key: 'elapsedMs', pattern: /\belapsedMs:\s*(\d{1,12})\b/ },
  { key: 'errorType', pattern: /\berrorType:\s*'([A-Za-z0-9_.-]{1,64})'/ },
  { key: 'upstreamBase', pattern: /\bupstreamBase:\s*'([A-Za-z0-9_.:/-]{1,120})'/ },
  { key: 'attempt', pattern: /\battempt:\s*(\d{1,4})\b/ },
];

/**
 * 把一条 proxy 记录的 `msg` 重建成「标记 + 白名单标量」。
 *
 * 标记取渲染对象之前那一截（`util.format` 把上下文对象渲染成 `{ … }` 接在字面量后面），
 * 因此对象里的任何值都不可能进标记。没有对象的纯字符串消息整条当标记，同样受长度上限与
 * `redact()` 约束。
 */
function rebuildProxyMsg(msg: string, homeDir?: string): string {
  const braceAt = msg.indexOf('{');
  const markerRaw = (braceAt >= 0 ? msg.slice(0, braceAt) : msg).trim();
  const marker = redact(markerRaw, homeDir).slice(0, MAX_MARKER_CHARS);
  const fields: string[] = [];
  for (const { key, pattern } of PROXY_FIELDS) {
    const m = pattern.exec(msg);
    if (m) fields.push(`${key}=${m[1]}`);
  }
  return fields.length > 0 ? `${marker} ${fields.join(' ')}`.trim() : marker;
}

/**
 * 解析一段 NDJSON 文本。
 *
 * 逐行 JSON.parse，坏行直接跳过（崩溃瞬间可能写了半行）。第四层字段白名单在这里体现：
 * 只从解析结果里取 `ts` / `level` / `source` / `scope` / `msg`，其余（`tz` / `seq` /
 * `sessionId` 以及未来任何新增字段）一概不看。
 */
export function parseAgentLogText(
  text: string,
  options: ParseAgentLogOptions,
): ParseAgentLogResult {
  const records: ParsedRecord[] = [];
  let linesScanned = 0;
  let droppedBySource = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (i === 0 && !options.fromFileStart) continue; // 半行
    const line = lines[i].trim();
    if (!line) continue;
    linesScanned += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 半行 / 坏行
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;

    const source = typeof rec.source === 'string' ? rec.source : '';
    const scope = typeof rec.scope === 'string' ? rec.scope : '';
    // 双闸:source 必须是 proxy,scope 也必须落在 proxy 根下。任一不满足就丢 ——
    // 单看 source 的话,一条 source 被写错的 maker 记录就能把用户内容带出去。
    if (source !== 'proxy' || !isProxyScope(scope)) {
      droppedBySource += 1;
      continue;
    }
    // 等级闸:debug / trace 整条丢(请求体 dump 就在 debug)。等级读不出来按 debug 处理 ——
    // 未知等级不该比明确的 debug 更宽松。
    const level = typeof rec.level === 'string' ? rec.level : 'debug';
    if (!ALLOWED_LEVELS.includes(level)) {
      droppedBySource += 1;
      continue;
    }
    const tsMs = typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : Number.NaN;
    if (!Number.isFinite(tsMs)) continue;
    const msg = typeof rec.msg === 'string' ? rec.msg : '';

    records.push({
      // NDJSON 存的是 epoch ms;转成与 main 流一致的本地 ISO + offset,后台两条流同一口径。
      ts: localIsoWithOffset(tsMs),
      tsMs,
      level,
      src: 'proxy',
      scope,
      // 逐字段重建,不搬原文 —— 理由见文件头。重建结果长度已被标记上限 + 白名单标量
      // 共同封顶,不需要再走 truncateMsg。
      msg: rebuildProxyMsg(msg, options.homeDir),
    });
  }

  return { records, linesScanned, droppedBySource };
}

/**
 * epoch ms → `2026-08-04T10:20:30.123+08:00`。
 *
 * 与 logger 的 `localTimestamp()` 同格式，让 main 流与 proxy 流在后台看起来是一条时间线。
 * 刻意用本机当前时区而不是记录里的 `tz` 字段：`tz` 不在字段白名单内（少一个字段就少一个
 * 需要论证安全性的出口），而同一台机器上跨时区改动对崩溃时间线的影响可以忽略。
 */
function localIsoWithOffset(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export const __testing = {
  PROXY_SCOPE_ROOTS,
  ALLOWED_LEVELS,
  PROXY_FIELDS,
  MAX_MARKER_CHARS,
  isProxyScope,
  rebuildProxyMsg,
  parseNdjsonTimestamp,
  localIsoWithOffset,
};
