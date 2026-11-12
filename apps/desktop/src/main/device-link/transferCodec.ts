import { createHash } from 'node:crypto';
import { compressGzipSync, gunzipBase64TextBounded, type CompressionStats } from '@cindy/device-link/node-compression';
import type { DeviceLinkTransferCodec } from '@cindy/device-link';
import { createLogger } from '../logger';

const log = createLogger('device-link:compression');

/** One DEBUG summary per window instead of one line per compressed reply (~16k/day). */
const COMPRESSION_STATS_WINDOW_MS = 5 * 60_000;
/** Synchronous gzip blocks the main event loop; a single slow call is worth its own line. */
const SLOW_COMPRESSION_MS = 100;

/**
 * 压缩统计聚合:只记原始／gzip／wire 字节与压缩耗时(不记录正文或凭证)。
 * 不起定时器——窗口到期后的下一次压缩才输出上一窗口的汇总,空闲时零开销;
 * 单次压缩超过 SLOW_COMPRESSION_MS 立即单独记一行。
 */
export function createCompressionStatsLog(
  emit: (event: string, fields: Record<string, unknown>) => void,
  now: () => number = Date.now,
  windowMs = COMPRESSION_STATS_WINDOW_MS,
): (stats: CompressionStats) => void {
  let startedAt = 0;
  let count = 0;
  let originalBytes = 0;
  let gzipBytes = 0;
  let wireBytes = 0;
  let compressionMs = 0;
  let maxCompressionMs = 0;
  return (stats) => {
    const at = now();
    if (count > 0 && at - startedAt >= windowMs) {
      emit('gzip summary', {
        count, originalBytes, gzipBytes, wireBytes,
        compressionMs: Math.round(compressionMs),
        maxCompressionMs: Math.round(maxCompressionMs),
        elapsedMs: at - startedAt,
      });
      count = 0; originalBytes = 0; gzipBytes = 0; wireBytes = 0; compressionMs = 0; maxCompressionMs = 0;
    }
    if (count === 0) startedAt = at;
    count++;
    originalBytes += stats.originalBytes;
    gzipBytes += stats.gzipBytes;
    wireBytes += stats.wireBytes;
    compressionMs += stats.compressionMs;
    maxCompressionMs = Math.max(maxCompressionMs, stats.compressionMs);
    if (stats.compressionMs >= SLOW_COMPRESSION_MS) emit('gzip slow candidate', { ...stats });
  };
}

const recordCompression = createCompressionStatsLog((event, fields) => log.debug(event, fields));

/**
 * Desktop 既是被控端也是控制端（桌面远控桌面），两个方向共用一份编码器。
 * 保留 level 4 和同步发送错误契约；Node 编解码通过独立入口复用。
 */
export const desktopTransferCodec: DeviceLinkTransferCodec = {
  gzipBase64: (text) => {
    const { compressed, stats } = compressGzipSync(Buffer.from(text, 'utf8'), 4, true);
    recordCompression(stats);
    return compressed.toString('base64');
  },
  gunzipBase64: gunzipBase64TextBounded,
  contentTag: (text) => createHash('sha256').update(text).digest('base64url'),
};
