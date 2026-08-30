/**
 * Codex fork 清洗与活尾巴测量。
 *
 * 超长订阅会话的 remote compaction v2 会把「上次 compact 之后」的 rollout
 * 整段发给 chatgpt.com。工具输出里的内联截图按 token 很便宜、按字节极大，
 * 于是出现 token 未满窗但压缩请求发不完的死锁。
 *
 * 清洗必须替换工具输出里的超大 data URI、不能删整行，以保住 call/output 配对。
 * 最近一轮的图也不能豁免：实测死锁尾巴就是最后一次 compact 之后的截图。
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';

/** 与 compaction-storm 同族的终态 reason：磁盘实测活尾巴过大，不是普通 timeout。 */
export const CODEX_HISTORY_OVERSIZED_REASON = 'codex_history_oversized';

/** 活尾巴超过这个字节数才有资格进入历史过大判定。 */
export const CODEX_LIVE_TAIL_OVERSIZED_BYTES = 8 * 1024 * 1024;

/** 预计清洗后仍超过这个值时，不把「瘦身」误报成可靠恢复。 */
export const CODEX_PROJECTED_LIVE_TAIL_MAX_BYTES = 8 * 1024 * 1024;

/** 内联 data URI 达到这个字符数才替换。小图标留下。 */
export const CODEX_INLINE_IMAGE_STRIP_MIN_CHARS = 64 * 1024;

/** 扫描保护：历史过大判定不应无界读取异常文件。 */
export const CODEX_ROLLOUT_SCAN_MAX_BYTES = 256 * 1024 * 1024;

/** 单行上限：必须在拼出完整字符串之前截断，不能等 readline 整行进内存。 */
export const CODEX_ROLLOUT_LINE_MAX_BYTES = 16 * 1024 * 1024;

export class CodexRolloutScanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRolloutScanLimitError';
  }
}

/** 只吃 base64 本体，不把后面的明文一起吞掉。空白也不能进字符集。 */
const INLINE_IMAGE_DATA_RE =
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/g;

function omittedInlineImagePlaceholder(chars: number): string {
  return `[cindy-omitted-inline-image chars=${chars}]`;
}

function isOversizedInlineDataUri(value: string): boolean {
  return (
    value.startsWith('data:image/') &&
    value.includes(';base64,') &&
    value.length >= CODEX_INLINE_IMAGE_STRIP_MIN_CHARS
  );
}

function imageUrlFromBlock(value: Record<string, unknown>): string | null {
  if (typeof value.image_url === 'string') return value.image_url;
  if (typeof value.imageUrl === 'string') return value.imageUrl;
  if (isRecord(value.image_url) && typeof value.image_url.url === 'string') {
    return value.image_url.url;
  }
  if (isRecord(value.imageUrl) && typeof value.imageUrl.url === 'string') {
    return value.imageUrl.url;
  }
  return null;
}

const TOOL_OUTPUT_TYPES = new Set([
  'custom_tool_call_output',
  'function_call_output',
  'customToolCallOutput',
  'functionCallOutput',
]);

export interface RolloutLiveTailStats {
  tailBytes: number;
  projectedTailBytes: number;
  strippedBytes: number;
  rewrittenLines: number;
  unsafeLines: number;
  scannedBytes: number;
}

export interface RolloutSanitizeStats {
  bytesBefore: number;
  bytesAfter: number;
  strippedBytes: number;
  rewrittenLines: number;
  unsafeLines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isReasoningPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.type === 'reasoning';
}

function isImageGenerationPayloadWithoutId(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const type = payload.type;
  if (typeof type !== 'string') return false;
  if (!type.startsWith('image_generation') && !type.startsWith('imageGeneration')) return false;
  const id = payload.id;
  return typeof id !== 'string' || id.trim().length === 0;
}

export function hasUnsafeForkRolloutPayload(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return false;
    const payload = parsed.payload;
    return isReasoningPayload(payload) || isImageGenerationPayloadWithoutId(payload);
  } catch {
    return false;
  }
}

/**
 * Rollout 的压缩边界不是 app-server item type：真实文件使用顶层 compacted，
 * 并在 event_msg 中补一条 context_compacted。未知形态不猜，继续累加而不是清零。
 */
export function isCompactionBoundaryLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return false;
    if (parsed.type === 'compacted') return true;
    return isRecord(parsed.payload) && parsed.type === 'event_msg' &&
      parsed.payload.type === 'context_compacted';
  } catch {
    return false;
  }
}

function isToolOutputPayload(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && typeof payload.type === 'string' && TOOL_OUTPUT_TYPES.has(payload.type);
}

function imageBytesInLine(line: string): number {
  if (!line.includes(';base64,')) return 0;
  let total = 0;
  for (const match of line.matchAll(INLINE_IMAGE_DATA_RE)) {
    if (match[0].length >= CODEX_INLINE_IMAGE_STRIP_MIN_CHARS) {
      total += Buffer.byteLength(match[0], 'utf8');
    }
  }
  return total;
}

function rewriteDataUrisInText(text: string): string {
  return text.replace(INLINE_IMAGE_DATA_RE, (match) => {
    if (match.length < CODEX_INLINE_IMAGE_STRIP_MIN_CHARS) return match;
    return omittedInlineImagePlaceholder(match.length);
  });
}

/**
 * 超大 data URI 不能留在 image_url 里：Responses 会按 URL 校验，占位字符串会 400。
 * 结构化 input_image 改成 input_text；普通字符串输出才原位替换。
 */
function isInputImageBlock(value: Record<string, unknown>): boolean {
  return value.type === 'input_image' || value.type === 'inputImage';
}

function rewriteToolOutputValue(value: unknown): unknown {
  if (typeof value === 'string') return rewriteDataUrisInText(value);
  if (Array.isArray(value)) return value.map(rewriteToolOutputValue);
  if (!isRecord(value)) return value;
  const imageUrl = imageUrlFromBlock(value);
  if (imageUrl && isOversizedInlineDataUri(imageUrl)) {
    if (isInputImageBlock(value)) {
      return { type: 'input_text', text: omittedInlineImagePlaceholder(imageUrl.length) };
    }
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'image_url' || key === 'imageUrl') continue;
      next[key] = rewriteToolOutputValue(child);
    }
    return next;
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = rewriteToolOutputValue(child);
  }
  return next;
}

export function rewriteOversizedToolOutputImages(line: string): string {
  if (!line.includes(';base64,')) return line;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || !isToolOutputPayload(parsed.payload)) return line;
    return JSON.stringify(rewriteToolOutputValue(parsed));
  } catch {
    return line;
  }
}

export function sanitizeCodexForkRollout(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (hasUnsafeForkRolloutPayload(line)) continue;
    out.push(rewriteOversizedToolOutputImages(line));
  }
  return out.join('\n');
}

function addLineStats(stats: RolloutLiveTailStats, line: string): void {
  if (!line) return;
  const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
  stats.tailBytes += lineBytes;
  if (hasUnsafeForkRolloutPayload(line)) {
    stats.unsafeLines += 1;
    return;
  }
  const rewritten = rewriteOversizedToolOutputImages(line);
  const rewrittenBytes = Buffer.byteLength(rewritten, 'utf8') + 1;
  stats.projectedTailBytes += rewrittenBytes;
  const imageBytes = imageBytesInLine(line);
  if (imageBytes > 0 && rewritten !== line) stats.rewrittenLines += 1;
  stats.strippedBytes += Math.max(0, lineBytes - rewrittenBytes);
}

export function measureRolloutLiveTailStatsFromText(text: string): RolloutLiveTailStats {
  const stats: RolloutLiveTailStats = {
    tailBytes: 0,
    projectedTailBytes: 0,
    strippedBytes: 0,
    rewrittenLines: 0,
    unsafeLines: 0,
    scannedBytes: Buffer.byteLength(text, 'utf8'),
  };
  for (const line of text.split(/\r?\n/)) {
    if (isCompactionBoundaryLine(line)) {
      stats.tailBytes = 0;
      stats.projectedTailBytes = 0;
      stats.strippedBytes = 0;
      stats.rewrittenLines = 0;
      stats.unsafeLines = 0;
      continue;
    }
    addLineStats(stats, line);
  }
  return stats;
}

export function measureRolloutLiveTailBytesFromText(text: string): number {
  return measureRolloutLiveTailStatsFromText(text).tailBytes;
}

/** 是否有足够的可剥离证据，不把普通大文本历史误报为图片病。 */
export function isOversizedLiveTailStats(stats: RolloutLiveTailStats): boolean {
  return stats.rewrittenLines > 0 &&
    stats.tailBytes > CODEX_LIVE_TAIL_OVERSIZED_BYTES &&
    stats.strippedBytes >= stats.tailBytes / 2 &&
    stats.projectedTailBytes <= CODEX_PROJECTED_LIVE_TAIL_MAX_BYTES;
}

function decodeRolloutLine(parts: Buffer[]): string {
  const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
  return line.subarray(0, end).toString('utf8');
}

async function* iterateRolloutLines(
  filePath: string,
  opts: { maxBytes?: number; maxLineBytes?: number } = {},
): AsyncGenerator<string> {
  const maxBytes = opts.maxBytes ?? CODEX_ROLLOUT_SCAN_MAX_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? CODEX_ROLLOUT_LINE_MAX_BYTES;
  const input = createReadStream(filePath);
  let scanned = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    for await (const chunk of input) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      scanned += buf.length;
      if (scanned > maxBytes) {
        throw new CodexRolloutScanLimitError(`Codex rollout scan exceeded ${maxBytes} bytes`);
      }
      let offset = 0;
      while (offset < buf.length) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl === -1) {
          const rest = buf.subarray(offset);
          if (pendingBytes + rest.length > maxLineBytes) {
            throw new CodexRolloutScanLimitError(`Codex rollout line exceeded ${maxLineBytes} bytes`);
          }
          pending.push(rest);
          pendingBytes += rest.length;
          break;
        }
        const piece = buf.subarray(offset, nl);
        if (pendingBytes + piece.length > maxLineBytes) {
          throw new CodexRolloutScanLimitError(`Codex rollout line exceeded ${maxLineBytes} bytes`);
        }
        yield decodeRolloutLine(pendingBytes === 0 ? [piece] : [...pending, piece]);
        pending = [];
        pendingBytes = 0;
        offset = nl + 1;
      }
    }
    if (pendingBytes > 0) {
      if (pendingBytes > maxLineBytes) {
        throw new CodexRolloutScanLimitError(`Codex rollout line exceeded ${maxLineBytes} bytes`);
      }
      yield decodeRolloutLine(pending);
    }
  } finally {
    input.destroy();
  }
}

export async function measureRolloutLiveTailStats(
  filePath: string,
  opts: { maxBytes?: number; maxLineBytes?: number } = {},
): Promise<RolloutLiveTailStats> {
  const stats: RolloutLiveTailStats = {
    tailBytes: 0,
    projectedTailBytes: 0,
    strippedBytes: 0,
    rewrittenLines: 0,
    unsafeLines: 0,
    scannedBytes: 0,
  };
  for await (const line of iterateRolloutLines(filePath, opts)) {
    stats.scannedBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (isCompactionBoundaryLine(line)) {
      stats.tailBytes = 0;
      stats.projectedTailBytes = 0;
      stats.strippedBytes = 0;
      stats.rewrittenLines = 0;
      stats.unsafeLines = 0;
      continue;
    }
    addLineStats(stats, line);
  }
  return stats;
}

export async function measureRolloutLiveTailBytes(filePath: string): Promise<number> {
  return (await measureRolloutLiveTailStats(filePath)).tailBytes;
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
  if (stream.write(chunk, 'utf8')) return;
  await once(stream, 'drain');
}

export async function sanitizeCodexForkRolloutFile(
  sourcePath: string,
  copyPath: string,
): Promise<RolloutSanitizeStats> {
  const output = createWriteStream(copyPath, { encoding: 'utf8' });
  const outputFailed = once(output, 'error').then((args) => {
    const err = Array.isArray(args) ? args[0] : args;
    throw err instanceof Error ? err : new Error(String(err));
  });
  void outputFailed.catch(() => undefined);
  const stats: RolloutSanitizeStats = {
    bytesBefore: 0,
    bytesAfter: 0,
    strippedBytes: 0,
    rewrittenLines: 0,
    unsafeLines: 0,
  };
  let first = true;
  try {
    await Promise.race([
      (async () => {
        for await (const line of iterateRolloutLines(sourcePath)) {
          const newline = first ? '' : '\n';
          first = false;
          const originalBytes = Buffer.byteLength(line, 'utf8') + (newline ? 1 : 0);
          stats.bytesBefore += originalBytes;
          if (hasUnsafeForkRolloutPayload(line)) {
            stats.unsafeLines += 1;
            stats.strippedBytes += originalBytes;
            continue;
          }
          const rewritten = rewriteOversizedToolOutputImages(line);
          const result = `${newline}${rewritten}`;
          const resultBytes = Buffer.byteLength(result, 'utf8');
          stats.bytesAfter += resultBytes;
          stats.strippedBytes += Math.max(0, originalBytes - resultBytes);
          if (rewritten !== line) stats.rewrittenLines += 1;
          await writeChunk(output, result);
        }
        if (!first) await writeChunk(output, '\n');
        await new Promise<void>((resolve, reject) => {
          output.end((error?: Error | null) => (error ? reject(error) : resolve()));
        });
      })(),
      outputFailed,
    ]);
  } catch (error) {
    output.destroy();
    await outputFailed.catch(() => undefined);
    throw error;
  } finally {
    if (!output.closed) output.destroy();
  }
  stats.bytesAfter += first ? 0 : 1;
  return stats;
}
