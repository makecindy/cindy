/**
 * 控制端 invoke 回包字节统计（debug 级，每 30s 一行）。
 *
 * 只在 debug 日志开启时计数：统计需要把回包再序列化一次，默认 info 级别不付这份开销。
 * 只记 channel（allowlist 内的固定名）与字节数，不记参数、内容或对端身份。
 */
import { REMOTE_INVOKE_ALLOWLIST } from '@cindy/device-link';
import { createLogger, getLogLevel } from '../logger';

const log = createLogger('device-link-transfer');

const FLUSH_MS = 30_000;
const TOP_CHANNELS = 8;

interface Counters {
  results: number;
  bytes: number;
  notModified: number;
  gzip: number;
}

const counters = new Map<string, Counters>();
let startedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  timer = undefined;
  if (counters.size === 0) return;
  const ranked = [...counters].sort((a, b) => b[1].bytes - a[1].bytes);
  let totalBytes = 0;
  let totalResults = 0;
  for (const [, c] of ranked) {
    totalBytes += c.bytes;
    totalResults += c.results;
  }
  log.debug('transport bytes', {
    elapsedMs: Date.now() - startedAt,
    results: totalResults,
    bytes: totalBytes,
    channels: Object.fromEntries(ranked.slice(0, TOP_CHANNELS)),
    ...(ranked.length > TOP_CHANNELS ? { channelsOmitted: ranked.length - TOP_CHANNELS } : {}),
  });
  counters.clear();
}

export const desktopInvokeTransferMetrics = {
  enabled(): boolean {
    const level = getLogLevel();
    return level === 'debug' || level === 'trace';
  },
  record(event: {
    channel: string;
    phase: 'sent' | 'result';
    payloadBytes?: number;
    notModified?: boolean;
    gzip?: boolean;
  }): void {
    if (event.phase !== 'result') return;
    const channel = REMOTE_INVOKE_ALLOWLIST.has(event.channel) ? event.channel : 'UNKNOWN';
    const entry = counters.get(channel) ?? { results: 0, bytes: 0, notModified: 0, gzip: 0 };
    entry.results++;
    entry.bytes += event.payloadBytes ?? 0;
    if (event.notModified) entry.notModified++;
    if (event.gzip) entry.gzip++;
    counters.set(channel, entry);
    if (!timer) {
      startedAt = Date.now();
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    }
  },
};
