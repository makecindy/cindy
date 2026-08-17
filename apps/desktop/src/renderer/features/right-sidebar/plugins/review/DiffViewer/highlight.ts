import type { DiffRenderRow } from './diffRows';

export const HIGHLIGHT_MAX_LINE_LENGTH = 1000;
export const HIGHLIGHT_MAX_DIFF_CHARS = 200_000;
// The highlighter sends one worker request per line. Virtualized medium diffs
// stay responsive by rendering plain text instead of queueing hundreds at once.
export const HIGHLIGHT_MAX_DIFF_LINES = 400;

type HighlightRequest = { id: string; code: string; lang: string };
type HighlightResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

const highlightCache = new LruCache<string, string>(2000);
const pending = new Map<string, Promise<string | null>>();
const callbacks = new Map<string, { resolve: (html: string) => void; reject: (err: Error) => void }>();
let worker: Worker | null = null;
let nextRequestId = 0;

export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    go: 'go',
    h: 'cpp',
    hpp: 'cpp',
    html: 'xml',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    kts: 'kotlin',
    less: 'css',
    m: 'objectivec',
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    mm: 'objectivec',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'bash',
    sql: 'sql',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'xml',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return map[ext] ?? ext;
}

export function shouldSkipHighlightLine(content: string): boolean {
  return content.length === 0 || content.length > HIGHLIGHT_MAX_LINE_LENGTH;
}

export function highlightLineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

export function collectHighlightLines(rows: readonly DiffRenderRow[]): Array<{ key: string; content: string }> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.type === 'line') {
      if (!shouldSkipHighlightLine(row.line.content)) {
        out.set(highlightLineKey(row.hunk.index, row.originalLineIndex), row.line.content);
      }
    } else if (row.type === 'split-line') {
      for (const cell of [row.left, row.right]) {
        if (cell && !shouldSkipHighlightLine(cell.line.content)) {
          out.set(highlightLineKey(row.hunk.index, cell.originalLineIndex), cell.line.content);
        }
      }
    }
  }
  return Array.from(out, ([key, content]) => ({ key, content }));
}

export function shouldSkipHighlightDiff(rows: readonly DiffRenderRow[]): boolean {
  let lineCount = 0;
  let charCount = 0;
  for (const line of collectHighlightLines(rows)) {
    lineCount += 1;
    charCount += line.content.length;
    if (lineCount > HIGHLIGHT_MAX_DIFF_LINES || charCount > HIGHLIGHT_MAX_DIFF_CHARS) {
      return true;
    }
  }
  return false;
}

export async function highlightLine(language: string, content: string): Promise<string | null> {
  if (shouldSkipHighlightLine(content)) return null;
  const cacheKey = `${language}\0${content}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const existing = pending.get(cacheKey);
  if (existing) return existing;

  const promise = requestWorkerHighlight(language, content)
    .then((html) => {
      highlightCache.set(cacheKey, html);
      return html;
    })
    .catch(() => null)
    .finally(() => pending.delete(cacheKey));
  pending.set(cacheKey, promise);
  return promise;
}

function requestWorkerHighlight(language: string, code: string): Promise<string> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Worker is not available'));
  const currentWorker = getWorker();
  const id = `diff-highlight-${Date.now()}-${nextRequestId++}`;
  const message: HighlightRequest = { id, code, lang: language };
  return new Promise((resolve, reject) => {
    callbacks.set(id, { resolve, reject });
    currentWorker.postMessage(message);
  });
}

function getWorker(): Worker {
  if (worker) return worker;
  const currentWorker = new Worker(new URL('../../../../../lib/highlight.worker.ts', import.meta.url), { type: 'module' });
  worker = currentWorker;
  currentWorker.addEventListener('message', (event: MessageEvent<HighlightResponse>) => {
    const response = event.data;
    const callback = callbacks.get(response.id);
    if (!callback) return;
    callbacks.delete(response.id);
    if (response.ok) callback.resolve(response.html);
    else callback.reject(new Error(response.error));
  });
  currentWorker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Highlight worker failed');
    for (const callback of callbacks.values()) callback.reject(error);
    callbacks.clear();
    currentWorker.terminate();
    if (worker === currentWorker) worker = null;
  });
  return currentWorker;
}
