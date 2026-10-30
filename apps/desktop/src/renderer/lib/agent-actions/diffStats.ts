/**
 * Diff analysis shared by compact tool rows and the diff lightbox.
 *
 * The expensive part of an Edit/MultiEdit preview is line diffing, not the
 * React markup. This module keeps the pure implementation available for
 * small inputs and tests, while larger inputs are sent to a module Worker.
 * Both callers use the same bounded cache, so a row's `+N/-N` summary and the
 * opened detail view never calculate the same pair twice.
 */

import { diffLines } from 'diff';

export interface DiffStat {
  add: number;
  del: number;
}

export interface DiffLine {
  type: 'del' | 'add' | 'ctx';
  text: string;
  lineNum: number;
}

export interface DiffDetails {
  rows: DiffLine[];
  stats: DiffStat;
  /** True when the input guard intentionally used a preview fallback. */
  truncated?: boolean;
  /** True when the row payload was capped, while stats remain exact. */
  rowsTruncated?: boolean;
  /** Number of rows omitted from the returned row payload, when known. */
  omittedRows?: number;
}

export interface ToolDiffSegmentInput {
  key: string;
  oldString: string;
  newString: string;
}

export interface ToolDiffSources {
  segments: ToolDiffSegmentInput[];
  truncated: boolean;
}

export interface ToolDiffDetails {
  stats: DiffStat;
  segments: Array<{ key: string; details: DiffDetails }>;
  truncated: boolean;
}

/** Keep the fast path small enough that a chat render cannot monopolize a frame. */
export const DIFF_MAIN_THREAD_MAX_CHARS = 32_000;
/** Hard input guard for the worker and its structured-clone payload. */
export const DIFF_MAX_INPUT_CHARS = 1_000_000;
/** MultiEdit/pi edit can contain arbitrary model-provided segment counts. */
export const DIFF_MAX_SEGMENTS = 200;
/** Bound the number of rows returned by a fallback preview. */
export const DIFF_MAX_PREVIEW_ROWS = 600;
/** Bound a single unbroken line in a fallback preview as well. */
export const DIFF_MAX_PREVIEW_LINE_CHARS = 16_384;
/** Keep worker responses and the virtualizer's row index bounded. */
export const DIFF_MAX_RENDER_ROWS = 20_000;
/** Virtualize before React creates a large row subtree. */
export const DIFF_VIRTUALIZE_THRESHOLD = 200;
const DIFF_CACHE_LIMIT = 96;

type WorkerRequest = {
  id: string;
  segments: ToolDiffSegmentInput[];
};

type WorkerResponse =
  { id: string; ok: true; result: ToolDiffDetails } | { id: string; ok: false; error: string };

interface CacheEntry {
  key: string;
  oldString: string;
  newString: string;
  details: DiffDetails;
  weight: number;
}

// An array-based LRU avoids concatenating whole source files into cache keys.
// Entries keep references to the message strings instead of making another
// potentially multi-megabyte copy.
const detailsCache: CacheEntry[] = [];
let detailsCacheWeight = 0;
const pendingDetails: Array<{
  oldString: string;
  newString: string;
  promise: Promise<DiffDetails>;
  resolve: (details: DiffDetails) => void;
}> = [];
let diffWorker: Worker | null = null;
let nextWorkerRequestId = 0;
const pendingToolRequests: Array<{
  toolName: string;
  sources: ToolDiffSources;
  promise: Promise<ToolDiffDetails>;
}> = [];
const pendingBatches: Array<{
  segments: ToolDiffSegmentInput[];
  promise: Promise<ToolDiffDetails>;
  resolve: (result: ToolDiffDetails) => void;
}> = [];
const DIFF_WORKER_TIMEOUT_MS = 5_000;
const DIFF_CACHE_WEIGHT_LIMIT = 2_000_000;

function cacheKey(oldString: string, newString: string): string {
  return `${oldString.length}:${newString.length}:${oldString.slice(0, 32)}:${newString.slice(0, 32)}`;
}

function getCachedDetails(oldString: string, newString: string): DiffDetails | undefined {
  const key = cacheKey(oldString, newString);
  const index = detailsCache.findIndex(
    (entry) => entry.key === key && entry.oldString === oldString && entry.newString === newString,
  );
  if (index < 0) return undefined;
  const [entry] = detailsCache.splice(index, 1);
  detailsCache.push(entry);
  return entry.details;
}

function setCachedDetails(oldString: string, newString: string, details: DiffDetails): void {
  const weight = details.rows.reduce((total, row) => total + row.text.length + 1, 0);
  // A cache hit must not retain many megabytes of rendered row objects. Large
  // results are still shared directly from AgentActionRow to the lightbox;
  // skipping the pair cache for them keeps unrelated messages bounded.
  if (weight > DIFF_CACHE_WEIGHT_LIMIT) return;
  const key = cacheKey(oldString, newString);
  const existing = detailsCache.findIndex(
    (entry) => entry.key === key && entry.oldString === oldString && entry.newString === newString,
  );
  if (existing >= 0) {
    detailsCacheWeight -= detailsCache[existing].weight;
    detailsCache.splice(existing, 1);
  }
  detailsCache.push({ key, oldString, newString, details, weight });
  detailsCacheWeight += weight;
  while (detailsCache.length > DIFF_CACHE_LIMIT || detailsCacheWeight > DIFF_CACHE_WEIGHT_LIMIT) {
    const evicted = detailsCache.shift();
    if (!evicted) break;
    detailsCacheWeight -= evicted.weight;
  }
}

function boundedDetailsForRequest(oldString: string, newString: string): DiffDetails {
  return oldString.length + newString.length > DIFF_MAIN_THREAD_MAX_CHARS
    ? computeBoundedDetails(oldString, newString)
    : computeDiffDetails(oldString, newString);
}

/**
 * A worker failure must never put a large batch back through diffLines on the
 * renderer thread. Keep this fallback deliberately bounded even when an
 * individual segment would otherwise fit the small-input fast path.
 */
function workerFallbackDetails(oldString: string, newString: string): DiffDetails {
  return computeBoundedDetails(oldString, newString);
}

function previewLines(text: string): string[] {
  const end = text.endsWith('\n') ? text.length - 1 : text.length;
  if (end === 0) return [];
  const previewLine = (start: number, stop: number) =>
    stop - start > DIFF_MAX_PREVIEW_LINE_CHARS
      ? `${text.slice(start, start + DIFF_MAX_PREVIEW_LINE_CHARS)}…`
      : text.slice(start, stop);
  const collectAllLines = (): string[] => {
    const lines: string[] = [];
    let start = 0;
    while (start <= end && lines.length < DIFF_MAX_PREVIEW_ROWS) {
      const newline = text.indexOf('\n', start);
      if (newline < 0 || newline >= end) {
        lines.push(previewLine(start, end));
        break;
      }
      lines.push(previewLine(start, newline));
      start = newline + 1;
    }
    return lines;
  };
  const head = Math.floor(DIFF_MAX_PREVIEW_ROWS / 2);
  const tail = DIFF_MAX_PREVIEW_ROWS - head;
  const headLines: string[] = [];
  let headStart = 0;
  for (let index = 0; index < head; index += 1) {
    const newline = text.indexOf('\n', headStart);
    if (newline < 0 || newline >= end) return [...headLines, previewLine(headStart, end)];
    headLines.push(previewLine(headStart, newline));
    headStart = newline + 1;
  }

  const tailLines: string[] = [];
  let tailEnd = end;
  for (let index = 0; index < tail; index += 1) {
    const newline = text.lastIndexOf('\n', tailEnd - 1);
    if (newline < headStart) {
      // The head/tail windows overlap, so the full text has at most the
      // preview limit of lines and can be materialized without duplication.
      return collectAllLines();
    }
    tailLines.unshift(previewLine(newline + 1, tailEnd));
    tailEnd = newline;
  }
  return [...headLines, ...tailLines];
}

/**
 * For an input that is too large for `diffLines`, retain a bounded head/tail
 * replacement preview. The full source remains in the payload for copy; only
 * the expensive analysis is bounded.
 */
function computeBoundedDetails(oldString: string, newString: string): DiffDetails {
  const oldLines = previewLines(oldString);
  const newLines = previewLines(newString);
  const rows: DiffLine[] = [];
  let lineNum = 1;
  for (const text of oldLines) rows.push({ type: 'del', text, lineNum: lineNum++ });
  for (const text of newLines) rows.push({ type: 'add', text, lineNum: lineNum++ });
  return {
    rows,
    // Truncated previews must stay bounded even if the original text is huge.
    // Callers suppress summary stats while `truncated` is true.
    stats: { add: newLines.length, del: oldLines.length },
    truncated: true,
  };
}

/** Count line-level additions and deletions using the historical DiffView semantics. */
export function computeDiffDetails(oldString: string, newString: string): DiffDetails {
  if (oldString.length + newString.length > DIFF_MAX_INPUT_CHARS) {
    return computeBoundedDetails(oldString, newString);
  }

  let add = 0;
  let del = 0;
  let rowsTruncated = false;
  const rows: DiffLine[] = [];
  let lineNum = 1;
  for (const change of diffLines(oldString, newString)) {
    const lines = change.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      const type: DiffLine['type'] = change.added ? 'add' : change.removed ? 'del' : 'ctx';
      if (rows.length < DIFF_MAX_RENDER_ROWS) rows.push({ type, text, lineNum });
      else rowsTruncated = true;
      lineNum += 1;
      if (type === 'add') add += 1;
      if (type === 'del') del += 1;
    }
  }
  return {
    rows,
    stats: { add, del },
    ...(rowsTruncated
      ? { rowsTruncated: true, omittedRows: Math.max(0, lineNum - 1 - rows.length) }
      : {}),
  };
}

/** Compatibility API used by existing non-chat diff panels. */
export function computeDiffStats(oldStr: string, newStr: string): DiffStat {
  return computeDiffDetails(oldStr, newStr).stats;
}

/** Count additions/deletions in an already-materialized unified diff. */
export function computeUnifiedDiffStats(raw: string): DiffStat | null {
  let add = 0;
  let del = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return add > 0 || del > 0 ? { add, del } : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function boundedPiEditSources(inp: Record<string, unknown>): ToolDiffSources {
  const segments: ToolDiffSegmentInput[] = [];
  let truncated = false;
  const rawEdits = Array.isArray(inp.edits) ? inp.edits : [];
  if (rawEdits.length > DIFF_MAX_SEGMENTS) truncated = true;
  for (let index = 0; index < Math.min(rawEdits.length, DIFF_MAX_SEGMENTS); index += 1) {
    const edit = readRecord(rawEdits[index]);
    const oldText = typeof edit?.oldText === 'string' ? edit.oldText : undefined;
    const newText = typeof edit?.newText === 'string' ? edit.newText : undefined;
    if (oldText === undefined && newText === undefined) continue;
    segments.push({
      key: `edit:${segments.length}`,
      oldString: oldText ?? '',
      newString: newText ?? '',
    });
  }
  if (typeof inp.oldText === 'string' && typeof inp.newText === 'string') {
    if (segments.length >= DIFF_MAX_SEGMENTS) truncated = true;
    else
      segments.push({
        key: `edit:${segments.length}`,
        oldString: inp.oldText,
        newString: inp.newText,
      });
  }
  return { segments, truncated };
}

/** Normalize Edit/Write/MultiEdit/pi edit input once for stats and details. */
export function diffSourcesForToolCall(
  toolName: string,
  toolInput: unknown,
): ToolDiffSources | null {
  const inp = readRecord(toolInput);
  if (!inp) return null;
  if (toolName === 'Edit') {
    return {
      segments: [
        {
          key: 'edit:0',
          oldString: typeof inp.old_string === 'string' ? inp.old_string : '',
          newString: typeof inp.new_string === 'string' ? inp.new_string : '',
        },
      ],
      truncated: false,
    };
  }
  if (toolName === 'Write' || toolName === 'write') {
    return {
      segments: [
        {
          key: 'write:0',
          oldString: '',
          newString: typeof inp.content === 'string' ? inp.content : '',
        },
      ],
      truncated: false,
    };
  }
  if (toolName === 'edit') return boundedPiEditSources(inp);
  if (toolName === 'MultiEdit') {
    const rawEdits = Array.isArray(inp.edits) ? inp.edits : [];
    const truncated = rawEdits.length > DIFF_MAX_SEGMENTS;
    const segments: ToolDiffSegmentInput[] = [];
    for (let index = 0; index < Math.min(rawEdits.length, DIFF_MAX_SEGMENTS); index += 1) {
      const edit = readRecord(rawEdits[index]);
      segments.push({
        key: `edit:${index}`,
        oldString: typeof edit?.old_string === 'string' ? edit.old_string : '',
        newString: typeof edit?.new_string === 'string' ? edit.new_string : '',
      });
    }
    return { segments, truncated };
  }
  return null;
}

function getDiffWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (diffWorker) return diffWorker;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  diffWorker = worker;
  worker.addEventListener('error', () => {
    failDiffWorker(worker);
    if (diffWorker === worker) diffWorker = null;
  });
  return worker;
}

function failDiffWorker(worker: Worker): void {
  for (const pending of [...pendingDetails]) {
    pending.resolve(workerFallbackDetails(pending.oldString, pending.newString));
  }
  for (const pending of [...pendingBatches]) {
    const segments = pending.segments.map((segment) => ({
      key: segment.key,
      details: workerFallbackDetails(segment.oldString, segment.newString),
    }));
    pending.resolve({ stats: aggregateStats(segments), segments, truncated: true });
  }
  worker.terminate();
  if (diffWorker === worker) diffWorker = null;
}

function aggregateStats(segments: Array<{ key: string; details: DiffDetails }>): DiffStat {
  return segments.reduce(
    (total, segment) => ({
      add: total.add + segment.details.stats.add,
      del: total.del + segment.details.stats.del,
    }),
    { add: 0, del: 0 },
  );
}

function sameSegments(a: ToolDiffSegmentInput[], b: ToolDiffSegmentInput[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (segment, index) =>
        segment.key === b[index].key &&
        segment.oldString === b[index].oldString &&
        segment.newString === b[index].newString,
    )
  );
}

function requestWorkerBatchDetails(segments: ToolDiffSegmentInput[]): Promise<ToolDiffDetails> {
  const existing = pendingBatches.find((pending) => sameSegments(pending.segments, segments));
  if (existing) return existing.promise;
  const worker = getDiffWorker();
  if (!worker) {
    const values = segments.map((segment) => ({
      key: segment.key,
      details: workerFallbackDetails(segment.oldString, segment.newString),
    }));
    return Promise.resolve({ stats: aggregateStats(values), segments: values, truncated: true });
  }
  const id = `diff-batch-${Date.now()}-${nextWorkerRequestId++}`;
  let resolveResult!: (result: ToolDiffDetails) => void;
  const promise = new Promise<ToolDiffDetails>((resolve) => {
    resolveResult = resolve;
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (!event.data.ok) {
        const values = segments.map((segment) => ({
          key: segment.key,
          details: workerFallbackDetails(segment.oldString, segment.newString),
        }));
        resolve({ stats: aggregateStats(values), segments: values, truncated: true });
        return;
      }
      for (const segment of event.data.result.segments) {
        const source = segments.find((candidate) => candidate.key === segment.key);
        if (source) setCachedDetails(source.oldString, source.newString, segment.details);
      }
      resolve(event.data.result);
    };
    worker.addEventListener('message', onMessage);
    globalThis.setTimeout(() => {
      if (!pendingBatches.some((pending) => pending.promise === promise)) return;
      worker.removeEventListener('message', onMessage);
      failDiffWorker(worker);
    }, DIFF_WORKER_TIMEOUT_MS);
    try {
      worker.postMessage({ id, segments } satisfies WorkerRequest);
    } catch {
      worker.removeEventListener('message', onMessage);
      const values = segments.map((segment) => ({
        key: segment.key,
        details: workerFallbackDetails(segment.oldString, segment.newString),
      }));
      resolve({ stats: aggregateStats(values), segments: values, truncated: true });
    }
  }).finally(() => {
    const index = pendingBatches.findIndex((pending) => pending.promise === promise);
    if (index >= 0) pendingBatches.splice(index, 1);
  });
  pendingBatches.push({ segments, promise, resolve: resolveResult });
  return promise;
}

function requestWorkerDetails(segment: ToolDiffSegmentInput): Promise<DiffDetails> {
  const worker = getDiffWorker();
  if (!worker)
    return Promise.resolve(workerFallbackDetails(segment.oldString, segment.newString));
  const existing = pendingDetails.find(
    (pending) => pending.oldString === segment.oldString && pending.newString === segment.newString,
  );
  if (existing) return existing.promise;
  const id = `diff-${Date.now()}-${nextWorkerRequestId++}`;
  let resolveResult!: (details: DiffDetails) => void;
  const promise = new Promise<DiffDetails>((resolve) => {
    resolveResult = resolve;
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (!event.data.ok) {
        resolve(workerFallbackDetails(segment.oldString, segment.newString));
        return;
      }
      const details =
        event.data.result.segments[0]?.details ??
        workerFallbackDetails(segment.oldString, segment.newString);
      setCachedDetails(segment.oldString, segment.newString, details);
      resolve(details);
    };
    worker.addEventListener('message', onMessage);
    globalThis.setTimeout(() => {
      if (!pendingDetails.some((pending) => pending.promise === promise)) return;
      worker.removeEventListener('message', onMessage);
      failDiffWorker(worker);
    }, DIFF_WORKER_TIMEOUT_MS);
    try {
      worker.postMessage({ id, segments: [segment] } satisfies WorkerRequest);
    } catch {
      worker.removeEventListener('message', onMessage);
      resolve(workerFallbackDetails(segment.oldString, segment.newString));
    }
  }).finally(() => {
    const index = pendingDetails.findIndex((pending) => pending.promise === promise);
    if (index >= 0) pendingDetails.splice(index, 1);
  });
  pendingDetails.push({
    oldString: segment.oldString,
    newString: segment.newString,
    promise,
    resolve: resolveResult,
  });
  return promise;
}

/** Request or retrieve the same pair-level analysis used by tool rows. */
export function getDiffDetailsSync(oldString: string, newString: string): DiffDetails | null {
  const cached = getCachedDetails(oldString, newString);
  if (cached) return cached;
  if (oldString.length + newString.length > DIFF_MAIN_THREAD_MAX_CHARS) return null;
  const details = computeDiffDetails(oldString, newString);
  setCachedDetails(oldString, newString, details);
  return details;
}

export function requestDiffDetails(oldString: string, newString: string): Promise<DiffDetails> {
  const sync = getDiffDetailsSync(oldString, newString);
  if (sync) return Promise.resolve(sync);
  if (oldString.length + newString.length > DIFF_MAX_INPUT_CHARS) {
    return Promise.resolve(computeBoundedDetails(oldString, newString));
  }
  const pendingBatch = pendingBatches.find((pending) =>
    pending.segments.some(
      (segment) => segment.oldString === oldString && segment.newString === newString,
    ),
  );
  if (pendingBatch) {
    return pendingBatch.promise.then((result) => {
      const source = pendingBatch.segments.find(
        (candidate) => candidate.oldString === oldString && candidate.newString === newString,
      );
      const hit = source
        ? result.segments.find((segment) => segment.key === source.key)
        : undefined;
      return hit?.details ?? boundedDetailsForRequest(oldString, newString);
    });
  }
  return requestWorkerDetails({ key: 'diff:0', oldString, newString });
}

/** Request one shared analysis for all segments in an Edit/MultiEdit call. */
export function requestToolDiffDetails(
  toolName: string,
  toolInput: unknown,
): Promise<ToolDiffDetails | null> {
  const sources = diffSourcesForToolCall(toolName, toolInput);
  if (!sources) return Promise.resolve(null);
  const existing = pendingToolRequests.find(
    (pending) =>
      pending.toolName === toolName &&
      pending.sources.truncated === sources.truncated &&
      sameSegments(pending.sources.segments, sources.segments),
  );
  if (existing) return existing.promise;

  const totalChars = sources.segments.reduce(
    (total, segment) => total + segment.oldString.length + segment.newString.length,
    0,
  );
  const allSmall = totalChars <= DIFF_MAIN_THREAD_MAX_CHARS;
  // Segment-count truncation limits what we analyse, but it does not require
  // falling back to renderer-thread work. The capped batch can still be sent
  // to the worker whenever its aggregate text budget is safe.
  const canDiffInWorker = totalChars <= DIFF_MAX_INPUT_CHARS;
  const cached = allSmall
    ? sources.segments.map((segment) => getCachedDetails(segment.oldString, segment.newString))
    : [];
  const promise = (async (): Promise<ToolDiffDetails> => {
    const details = [] as Array<{ key: string; details: DiffDetails }>;
    const missing = sources.segments.filter(
      (segment) => !getCachedDetails(segment.oldString, segment.newString),
    );
    const workerValues =
      canDiffInWorker && !allSmall && missing.length > 0
        ? await requestWorkerBatchDetails(missing)
        : null;
    for (let index = 0; index < sources.segments.length; index += 1) {
      const segment = sources.segments[index];
      const hit = cached[index] ?? getCachedDetails(segment.oldString, segment.newString);
      const value =
        hit ??
        workerValues?.segments.find((candidate) => candidate.key === segment.key)?.details ??
        (allSmall
          ? computeDiffDetails(segment.oldString, segment.newString)
          : computeBoundedDetails(segment.oldString, segment.newString));
      if (!hit) setCachedDetails(segment.oldString, segment.newString, value);
      details.push({ key: segment.key, details: value });
    }
    return {
      stats: aggregateStats(details),
      segments: details,
      truncated:
        sources.truncated ||
        !canDiffInWorker ||
        details.some((segment) => segment.details.truncated === true),
    };
  })().finally(() => {
    const index = pendingToolRequests.findIndex((pending) => pending.promise === promise);
    if (index >= 0) pendingToolRequests.splice(index, 1);
  });
  pendingToolRequests.push({ toolName, sources, promise });
  return promise;
}

/** Synchronous compatibility path; large inputs return null until the worker resolves. */
export function statsForToolCall(toolName: string, toolInput: unknown): DiffStat | null {
  const inp = readRecord(toolInput);
  if (!inp) return null;
  if (toolName === 'file_change') {
    const changes = Array.isArray(inp.changes) ? inp.changes : [];
    let add = 0;
    let del = 0;
    let hasDiff = false;
    for (const change of changes) {
      const diff = readRecord(change)?.diff;
      if (typeof diff !== 'string') continue;
      const stats = computeUnifiedDiffStats(diff);
      if (!stats) continue;
      hasDiff = true;
      add += stats.add;
      del += stats.del;
    }
    return hasDiff ? { add, del } : null;
  }
  const sources = diffSourcesForToolCall(toolName, inp);
  if (!sources || sources.truncated) return null;
  const totalChars = sources.segments.reduce(
    (total, segment) => total + segment.oldString.length + segment.newString.length,
    0,
  );
  if (totalChars > DIFF_MAIN_THREAD_MAX_CHARS) return null;
  return sources.segments.reduce(
    (total, segment) => {
      const details =
        getCachedDetails(segment.oldString, segment.newString) ??
        computeDiffDetails(segment.oldString, segment.newString);
      setCachedDetails(segment.oldString, segment.newString, details);
      return { add: total.add + details.stats.add, del: total.del + details.stats.del };
    },
    { add: 0, del: 0 },
  );
}
