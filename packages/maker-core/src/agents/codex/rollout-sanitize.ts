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
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';

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

/**
 * The fork app-server may keep its rollout handle briefly after retirement on
 * Windows. Retry only the atomic replacement, long enough to outlive the
 * transport's five-second force-kill grace period.
 */
export const CODEX_ROLLOUT_REPLACE_MAX_ATTEMPTS = 61;
export const CODEX_ROLLOUT_REPLACE_RETRY_MS = 100;
export const CODEX_HISTORY_BASE_MAX_DEPTH = 8;

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

function safeForkPlaceholderLine(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return line;
    // Preserve the rollout ordinal while removing encrypted reasoning and
    // image-generation payloads that are provider-specific or unverifiable.
    // A normal message item is accepted by Codex's durable projection and
    // keeps the sequence contiguous after sanitization.
    return JSON.stringify({
      ...parsed,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[content omitted]' }],
      },
    });
  } catch {
    return line;
  }
}

export async function sanitizeCodexForkRolloutFile(
  sourcePath: string,
  copyPath: string,
): Promise<RolloutSanitizeStats> {
  return sanitizeCodexForkRolloutLines(iterateRolloutLines(sourcePath), copyPath);
}

async function sanitizeCodexForkRolloutLines(
  lines: AsyncIterable<string>,
  copyPath: string,
  opts: { preserveOrdinals?: boolean } = {},
): Promise<RolloutSanitizeStats> {
  const output = createWriteStream(copyPath, { encoding: 'utf8' });
  const outputFailed = once(output, 'error').then((args) => {
    const err = Array.isArray(args) ? args[0] : args;
    throw err instanceof Error ? err : new Error(String(err));
  });
  const outputClosed = once(output, 'close').then(() => undefined);
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
        for await (const line of lines) {
          const newline = first ? '' : '\n';
          first = false;
          const originalBytes = Buffer.byteLength(line, 'utf8') + (newline ? 1 : 0);
          stats.bytesBefore += originalBytes;
          if (hasUnsafeForkRolloutPayload(line)) {
            stats.unsafeLines += 1;
            if (!opts.preserveOrdinals) {
              stats.strippedBytes += originalBytes;
              continue;
            }
            const placeholder = safeForkPlaceholderLine(line);
            const result = `${newline}${placeholder}`;
            const resultBytes = Buffer.byteLength(result, 'utf8');
            stats.bytesAfter += resultBytes;
            stats.strippedBytes += Math.max(0, originalBytes - resultBytes);
            await writeChunk(output, result);
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
    await outputClosed.catch(() => undefined);
    throw error;
  } finally {
    if (!output.closed) {
      output.destroy();
      await outputClosed.catch(() => undefined);
    }
  }
  stats.bytesAfter += first ? 0 : 1;
  return stats;
}

export interface SanitizeCodexForkRolloutInPlaceOptions {
  replaceMaxAttempts?: number;
  replaceRetryMs?: number;
  /** Resolve a lazy history_base thread id to its canonical rollout file. */
  resolveHistoryBaseRollout?: (threadId: string) => string | null | Promise<string | null>;
}

interface ForkSessionMeta {
  record: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function parseForkSessionMeta(line: string): ForkSessionMeta | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.type !== 'session_meta' || !isRecord(parsed.payload)) {
      return null;
    }
    return { record: parsed, payload: parsed.payload };
  } catch {
    return null;
  }
}

function validateLazyHistoryBase(meta: ForkSessionMeta, filePath: string): boolean {
  const historyBase = meta.payload.history_base;
  if (historyBase === undefined || historyBase === null) return false;
  if (!isRecord(historyBase)) {
    throw new Error(`Codex rollout history_base is invalid: ${filePath}`);
  }
  if (
    typeof historyBase.thread_id !== 'string' || historyBase.thread_id.trim().length === 0 ||
    !Number.isSafeInteger(historyBase.end_ordinal_exclusive) ||
    (historyBase.end_ordinal_exclusive as number) <= 0 ||
    !Number.isSafeInteger(historyBase.end_byte_offset) ||
    (historyBase.end_byte_offset as number) <= 0
  ) {
    throw new Error(`Codex rollout history_base fields are invalid: ${filePath}`);
  }
  return true;
}

function detachForkLineage(meta: ForkSessionMeta, detachHistoryBase = false): string {
  const payload = { ...meta.payload };
  delete payload.forked_from_id;
  delete payload.forked_from_ordinal_exclusive;
  if (detachHistoryBase) delete payload.history_base;
  return JSON.stringify({ ...meta.record, ordinal: 0, payload });
}

async function readRolloutLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iterateRolloutLines(filePath)) lines.push(line);
  return lines;
}

async function readRolloutPrefixLines(filePath: string, endByteOffset: number): Promise<string[]> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > CODEX_ROLLOUT_SCAN_MAX_BYTES || endByteOffset > stat.size) {
    if (stat.size > CODEX_ROLLOUT_SCAN_MAX_BYTES) {
      throw new CodexRolloutScanLimitError(`Codex rollout scan exceeded ${CODEX_ROLLOUT_SCAN_MAX_BYTES} bytes`);
    }
    throw new Error(`Codex rollout history_base offset is out of bounds: ${filePath}`);
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.length !== stat.size) {
    throw new Error(`Codex rollout changed while resolving history_base: ${filePath}`);
  }
  if (endByteOffset < bytes.length && bytes[endByteOffset - 1] !== 0x0a) {
    throw new Error(`Codex rollout history_base offset is not a line boundary: ${filePath}`);
  }
  const prefix = bytes.subarray(0, endByteOffset).toString('utf8');
  const lines = prefix.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

async function materializeHistoryPrefix(
  filePath: string,
  lines: string[],
  resolveHistoryBaseRollout: NonNullable<SanitizeCodexForkRolloutInPlaceOptions['resolveHistoryBaseRollout']>,
  depth: number,
  seen: Set<string>,
): Promise<string[]> {
  if (depth > CODEX_HISTORY_BASE_MAX_DEPTH) {
    throw new Error(`Codex rollout history_base chain is too deep: ${filePath}`);
  }
  const meta = parseForkSessionMeta(lines[0] ?? '');
  if (!meta) throw new Error(`Codex rollout history_base source metadata is invalid: ${filePath}`);
  if (!validateLazyHistoryBase(meta, filePath)) return lines.slice(1);
  const historyBase = meta.payload.history_base as Record<string, unknown>;
  const sourcePath = await resolveHistoryBaseRollout(String(historyBase.thread_id));
  if (!sourcePath) {
    throw new Error(`Codex rollout history_base source is unavailable: ${historyBase.thread_id}`);
  }
  const canonicalSource = path.resolve(sourcePath);
  if (seen.has(canonicalSource)) {
    throw new Error(`Codex rollout history_base cycle detected: ${canonicalSource}`);
  }
  seen.add(canonicalSource);
  try {
    const sourceLines = await readRolloutPrefixLines(
      sourcePath,
      historyBase.end_byte_offset as number,
    );
    const sourceMeta = parseForkSessionMeta(sourceLines[0] ?? '');
    if (!sourceMeta) {
      throw new Error(`Codex rollout history_base source metadata is invalid: ${sourcePath}`);
    }
    const sourceHistory = validateLazyHistoryBase(sourceMeta, sourcePath)
      ? await materializeHistoryPrefix(
        sourcePath,
        sourceLines,
        resolveHistoryBaseRollout,
        depth + 1,
        seen,
      )
      : sourceLines.slice(1);
    return [...sourceHistory, ...lines.slice(1)];
  } finally {
    seen.delete(canonicalSource);
  }
}

async function materializeLazyForkRollout(
  filePath: string,
  childLines: string[],
  childMeta: ForkSessionMeta,
  resolveHistoryBaseRollout: NonNullable<SanitizeCodexForkRolloutInPlaceOptions['resolveHistoryBaseRollout']>,
): Promise<string[]> {
  const childPath = path.resolve(filePath);
  const historyBase = childMeta.payload.history_base as Record<string, unknown>;
  const sourcePath = await resolveHistoryBaseRollout(String(historyBase.thread_id));
  if (!sourcePath) {
    throw new Error(`Codex rollout history_base source is unavailable: ${historyBase.thread_id}`);
  }
  const sourceLines = await readRolloutPrefixLines(
    sourcePath,
    historyBase.end_byte_offset as number,
  );
  const history = await materializeHistoryPrefix(
    sourcePath,
    sourceLines,
    resolveHistoryBaseRollout,
    0,
    new Set([childPath, path.resolve(sourcePath)]),
  );
  return [detachForkLineage(childMeta, true), ...history, ...childLines.slice(1)];
}

async function* iterateForkRolloutLines(filePath: string): AsyncGenerator<string> {
  const iterator = iterateRolloutLines(filePath)[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done) return;
    const meta = parseForkSessionMeta(first.value);
    yield meta && !validateLazyHistoryBase(meta, filePath)
      ? detachForkLineage(meta)
      : first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

function isTransientRolloutReplaceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

async function replaceRolloutWithRetry(
  stagingPath: string,
  filePath: string,
  opts: SanitizeCodexForkRolloutInPlaceOptions,
): Promise<void> {
  const requestedAttempts = opts.replaceMaxAttempts;
  const maxAttempts = typeof requestedAttempts === 'number' &&
    Number.isFinite(requestedAttempts) && requestedAttempts > 0
    ? Math.max(1, Math.floor(requestedAttempts))
    : CODEX_ROLLOUT_REPLACE_MAX_ATTEMPTS;
  const requestedRetryMs = opts.replaceRetryMs;
  const retryMs = typeof requestedRetryMs === 'number' &&
    Number.isFinite(requestedRetryMs) && requestedRetryMs >= 0
    ? Math.floor(requestedRetryMs)
    : CODEX_ROLLOUT_REPLACE_RETRY_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rename(stagingPath, filePath);
      return;
    } catch (error) {
      if (!isTransientRolloutReplaceError(error) || attempt === maxAttempts) throw error;
      if (retryMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }
}

/**
 * Replace an unloaded fork child's rollout without exposing a partial file at
 * its canonical path. The staging file is a sibling so the final rename stays
 * on one filesystem and is atomic.
 */
export async function sanitizeCodexForkRolloutFileInPlace(
  filePath: string,
  opts: SanitizeCodexForkRolloutInPlaceOptions = {},
): Promise<RolloutSanitizeStats> {
  const stagingPath = `${filePath}.cindy-sanitize-${process.pid}-${randomUUID()}.tmp`;
  try {
    const childLines = await readRolloutLines(filePath);
    const childMeta = parseForkSessionMeta(childLines[0] ?? '');
    let lines: AsyncIterable<string> = iterateForkRolloutLines(filePath);
    if (childMeta && validateLazyHistoryBase(childMeta, filePath)) {
      if (!opts.resolveHistoryBaseRollout) {
        throw new Error(`Codex lazy fork requires a history_base resolver: ${filePath}`);
      }
      const materialized = await materializeLazyForkRollout(
        filePath,
        childLines,
        childMeta,
        opts.resolveHistoryBaseRollout,
      );
      lines = (async function* (): AsyncGenerator<string> {
        yield* materialized;
      })();
    }
    const stats = await sanitizeCodexForkRolloutLines(lines, stagingPath, { preserveOrdinals: true });
    await replaceRolloutWithRetry(stagingPath, filePath, opts);
    return stats;
  } catch (error) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
