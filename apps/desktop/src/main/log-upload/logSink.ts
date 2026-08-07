/**
 * 免签写入客户端（日志服务 web tracking）。
 *
 * 客户端**不持有任何 AccessKey / 密钥**（需求 §5.3）：写入走 logstore 的 web tracking
 * 通道，靠 project + logstore 定位，不带签名。
 *
 * 时间戳：web tracking 的 `__time__` 由服务端接收时刻决定，所以**原始时间戳一律作为普通
 * 字段 `ts` 携带**（需求 §4.8「记录本身保留原始时间戳，不能用上报时刻覆盖」由此满足），
 * 不依赖 `__time__`。
 *
 * 环境元数据同时写进 `__tags__`（可检索）**与每条记录的 `uploadCode` 字段**：`__tags__`
 * 的索引配置属服务端侧，客户端不该依赖一个自己看不到的配置才能被检索到。每条多一个短字段
 * 的体量代价可以接受。
 *
 * 纯逻辑：`fetchImpl` 注入，单测用内存 fake 断言 URL / 批次切分 / 失败语义。
 */

import { BATCH_TIMEOUT_MS, MAX_BATCH_BYTES, MAX_LOGS_PER_BATCH } from './limits';
import type { LogUploadMeta, LogUploadTarget, UploadRecord } from './types';

export interface LogSinkDeps {
  /** 生产实现为 `outboundFetch`（吃系统代理）；测试注入内存 fake。 */
  fetchImpl(input: string, init?: RequestInit): Promise<Response>;
}

export type LogSinkResult =
  | { ok: true; batches: number; records: number }
  /** status 0 = 网络层失败（离线 / DNS / 超时）。 */
  | { ok: false; batches: number; sentRecords: number; status: number };

/** 单条上报记录在 wire 上的形状。值全部是字符串——web tracking 只接受字符串字段。 */
function toWireLog(record: UploadRecord, uploadCode: string): Record<string, string> {
  return {
    ts: record.ts,
    level: record.level,
    src: record.src,
    scope: record.scope,
    msg: record.msg,
    uploadCode,
  };
}

/** 元数据转成 `__tags__`：全部字符串，缺失项不写（不写空串，省得后台把 '' 当有效值）。 */
export function toWireTags(meta: LogUploadMeta): Record<string, string> {
  const tags: Record<string, string> = {
    uploadCode: meta.uploadCode,
    deviceId: meta.deviceId,
    appVersion: meta.appVersion,
    region: meta.region,
    platform: meta.platform,
    arch: meta.arch,
    osVersion: meta.osVersion,
    uiLanguage: meta.uiLanguage,
    reason: meta.reason,
  };
  // 未登录时 userId 为空串:显式写一个空值反而会让后台的「有值/无值」判断变复杂,直接不写。
  if (meta.userId) tags.userId = meta.userId;
  if (meta.crashToken) tags.crashToken = meta.crashToken;
  if (meta.crashAtMs !== undefined) tags.crashAtMs = String(meta.crashAtMs);
  return tags;
}

export function buildTrackUrl(target: LogUploadTarget): string {
  return `https://${target.project}.${target.endpointHost}/logstores/${target.logstore}/track`;
}

/**
 * 单条记录在 `__logs__` 数组里的额外开销：分隔用的逗号。envelope 本身
 * （`__topic__` / `__source__` / `__tags__` / 括号）由 `ENVELOPE_RESERVE_BYTES` 兜。
 */
const PER_RECORD_OVERHEAD_BYTES = 1;

/**
 * 留给 envelope 的字节。`__tags__` 里有 version / platform / arch / userId / crashToken
 * 这些短串，几百字节量级，这里给 4KB 富余。
 */
const ENVELOPE_RESERVE_BYTES = 4 * 1024;

/**
 * 按条数与字节双上限切批。
 *
 * 字节必须按 **UTF-8** 数（`Buffer.byteLength`）：`JSON.stringify(log).length` 是 UTF-16
 * 码元数，中文一个字符算 1 而实际占 3 字节，emoji 更是 2 : 4——那是**低估**，会让一批在估算
 * 里没超限、编码后实际接近或超过服务端上限，被整批拒收，而崩溃标记因此留着反复重试
 * （2026-08-04 review P2；本函数原先的注释把它写成「保守高估」，方向恰好写反了）。
 *
 * 单条就超过预算时仍然单独成批：正文已在第四层截断过，这里再丢一次不如让服务端按自己的
 * 规则拒，我们据此收到明确的失败。
 */
export function splitBatches(
  records: readonly UploadRecord[],
  uploadCode: string,
): Array<Array<Record<string, string>>> {
  const budget = MAX_BATCH_BYTES - ENVELOPE_RESERVE_BYTES;
  const batches: Array<Array<Record<string, string>>> = [];
  let current: Array<Record<string, string>> = [];
  let currentBytes = 0;
  for (const record of records) {
    const log = toWireLog(record, uploadCode);
    const bytes = Buffer.byteLength(JSON.stringify(log), 'utf8') + PER_RECORD_OVERHEAD_BYTES;
    const wouldExceed =
      current.length >= MAX_LOGS_PER_BATCH ||
      (current.length > 0 && currentBytes + bytes > budget);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(log);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function postBatch(
  deps: LogSinkDeps,
  url: string,
  body: string,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
  try {
    const res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // PutWebtracking 的两个必选头(见阿里云 SLS API 文档):缺任一部分区域直接 400。
        //   x-log-apiversion：接口版本;
        //   x-log-bodyrawsize：**未压缩**正文的字节数。我们不压缩(不发 x-log-compresstype),
        //     所以就是 body 的 UTF-8 字节数。必须按字节数,不能用 body.length(UTF-16 码元)。
        'x-log-apiversion': '0.6.0',
        'x-log-bodyrawsize': String(Buffer.byteLength(body, 'utf8')),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    // 网络层失败(离线 / DNS / abort):status 0,调用方据此保留待补传标记。
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发送一次上报。批次**串行**发送，任一批失败即整次判失败并停止后续批次。
 *
 * 为什么整次判失败：调用方靠「确实传成功且非空」才清除待补传标记。部分成功当成成功会让
 * 标记被清掉，剩下的记录永远补不上；当成失败最多是下次重传一遍（后台按 uploadCode 能看出
 * 是两次上报），代价小得多。
 */
export async function sendLogs(
  deps: LogSinkDeps,
  target: LogUploadTarget,
  meta: LogUploadMeta,
  records: readonly UploadRecord[],
): Promise<LogSinkResult> {
  const url = buildTrackUrl(target);
  const tags = toWireTags(meta);
  const batches = splitBatches(records, meta.uploadCode);
  let sentRecords = 0;
  for (let i = 0; i < batches.length; i += 1) {
    const body = JSON.stringify({
      __topic__: 'cindy-client-log',
      __source__: `${meta.platform}-${meta.arch}`,
      __tags__: tags,
      __logs__: batches[i],
    });
    const res = await postBatch(deps, url, body);
    if (!res.ok) {
      return { ok: false, batches: i, sentRecords, status: res.status };
    }
    sentRecords += batches[i].length;
  }
  return { ok: true, batches: batches.length, records: sentRecords };
}

export const __testing = { toWireLog, ENVELOPE_RESERVE_BYTES, PER_RECORD_OVERHEAD_BYTES };
