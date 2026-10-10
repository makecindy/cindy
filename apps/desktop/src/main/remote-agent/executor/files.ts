/**
 * 远程 Agent 执行器的文件操作(控制端)。
 *
 * 两层：
 *  - 原始操作(读字节、写字节、建目录、查信息、列目录、找文件、搜内容)：给 Pi 用。Pi 的
 *    read / write / edit / ls / find / grep 工具逻辑原样跑在 Agent 所在电脑上，只把落盘动作换成这里；
 *  - Claude Code 风格的 Read / Write / Edit / NotebookEdit：Claude Code 的自带文件工具关掉后由
 *    Cindy 工具顶替，行为对齐自带工具(行号、偏移、先读后改、精确替换、唯一性、换行风格)。
 *
 * 路径均已由调用方解析为本机绝对路径并通过权限上限检查。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { getDefaultImageResizer } from '@cindy/maker-core';

/** 原始读取上限：Pi 的 read 先整读再截断，过大的文件在本机这一侧就拒绝。 */
export const EXECUTOR_RAW_READ_MAX_BYTES = 16 * 1024 * 1024;
/** Read 不带 offset / limit 时允许整读的最大文件。 */
export const CC_READ_MAX_FULL_BYTES = 256 * 1024;
export const CC_READ_DEFAULT_LIMIT = 2000;
export const CC_READ_MAX_LINE_CHARS = 2000;
/** 单张图片给模型的上限(base64 前)。 */
const CC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CC_PDF_MAX_BYTES = 32 * 1024 * 1024;
/** 一次 Read 最多读的 PDF 页数(与自带 Read 的页数上限一致)。 */
export const CC_PDF_MAX_PAGES_PER_READ = 20;
/** 一次 Read 返回的 PDF 文字上限。 */
export const CC_PDF_MAX_CHARS = 100_000;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
/** 需要先压缩/转码才能给模型的图片格式。 */
const CONVERTIBLE_IMAGE_EXTENSIONS = new Set(['.bmp', '.avif', '.ico', '.tiff', '.tif', '.heic', '.heif']);

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export class ExecutorToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorToolError';
  }
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

// ─── 原始操作(Pi)─────────────────────────────────────────────────

export async function rawReadFile(absPath: string): Promise<Buffer> {
  const stat = await fsp.stat(absPath);
  if (stat.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${absPath}'`), { code: 'EISDIR' });
  if (stat.size > EXECUTOR_RAW_READ_MAX_BYTES) {
    throw new ExecutorToolError(`File is too large to read through the remote connection (${stat.size} bytes, limit ${EXECUTOR_RAW_READ_MAX_BYTES}).`);
  }
  return fsp.readFile(absPath);
}

export async function rawAccess(absPath: string, mode: 'read' | 'write'): Promise<void> {
  await fsp.access(absPath, mode === 'write' ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
}

export async function rawWriteFile(absPath: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, data);
}

export async function rawMkdir(absPath: string): Promise<void> {
  await fsp.mkdir(absPath, { recursive: true });
}

export interface RawStat {
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

export async function rawStat(absPath: string): Promise<RawStat> {
  const stat = await fsp.stat(absPath);
  return {
    type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export async function rawReaddir(absPath: string): Promise<string[]> {
  return fsp.readdir(absPath);
}

/** 按魔数识别图片类型(与 Pi 内置 detectImageMimeType 同一组格式)。 */
export async function detectImageMime(absPath: string): Promise<string | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(absPath, 'r');
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    const b = header.subarray(0, bytesRead);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface RipgrepRunner {
  /** 返回 rg 的 stdout 行；达到 maxLines 时提前结束。退出码 1(无匹配)视为正常。 */
  (args: string[], cwd: string, opts: { maxLines: number; signal?: AbortSignal }): Promise<string[]>;
}

export function createRipgrepRunner(rgPath: string): RipgrepRunner {
  return (args, cwd, { maxLines, signal }) => new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const lines: string[] = [];
    let stderr = '';
    let stopped = false;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      if (stopped) return;
      lines.push(line);
      if (lines.length >= maxLines) {
        stopped = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reader.close();
      reject(error);
    });
    child.on('close', (code) => {
      reader.close();
      if (!stopped && code !== 0 && code !== 1) {
        reject(new ExecutorToolError(stderr.trim() || `ripgrep exited with code ${String(code)}`));
        return;
      }
      resolve(lines);
    });
  });
}

/** Pi find 的后端：按 glob 列文件(遵守 .gitignore)，返回绝对路径。 */
export async function rawGlob(
  rg: RipgrepRunner,
  pattern: string,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const lines = await rg(['--files', '--hidden', '--glob', '!.git', '--glob', pattern], cwd, {
    maxLines: Math.max(1, Math.min(limit, 10_000)),
    signal,
  });
  return lines.map((line) => path.resolve(cwd, line));
}

// ─── Claude Code 风格工具 ─────────────────────────────────────────

/** 每个任务一份：记录读过哪些文件，写入/编辑前校验「先读过且之后没被改过」。 */
export class ReadStateTracker {
  private readonly state = new Map<string, number>();

  record(absPath: string, mtimeMs: number): void {
    this.state.set(path.resolve(absPath), mtimeMs);
    if (this.state.size > 4096) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
  }

  /** 已存在文件写入前的检查；返回错误信息或 null。 */
  async check(absPath: string): Promise<string | null> {
    const recorded = this.state.get(path.resolve(absPath));
    if (recorded === undefined) return 'File has not been read yet. Read it first before writing to it.';
    const stat = await fsp.stat(absPath);
    if (Math.floor(stat.mtimeMs) > Math.floor(recorded)) {
      return 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.';
    }
    return null;
  }
}

async function statOrNull(absPath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

function truncateLine(line: string): string {
  return line.length > CC_READ_MAX_LINE_CHARS ? line.slice(0, CC_READ_MAX_LINE_CHARS) : line;
}

function formatNumberedLines(lines: string[], firstLine: number): string {
  return lines.map((line, index) => `${firstLine + index}\t${truncateLine(line)}`).join('\n');
}

export interface CcReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

/**
 * 取 PDF 第 1..lastPage 页的文字。sections 每段以 `--- 第 N 页 ---` 开头(只含有文字的页)。
 * 与审查读 PDF 交付物是同一个抽取进程。
 */
export type PdfTextExtractor = (data: Uint8Array, lastPage: number, maxChars: number) => Promise<{
  sections: string[];
  numPages: number;
  pagesInspected: number;
  clipped: boolean;
}>;

/** `"3"` / `"1-5"` → 页码范围；格式不对返回 null。 */
export function parsePdfPageRange(pages: string): { first: number; last: number } | null {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return null;
  return { first, last };
}

/**
 * PDF 的 Read：自带 Read 把 PDF 整份交给模型，Cindy 工具的结果只能是文字和图片(其他二进制会被
 * Agent 存到它自己那台电脑的临时文件里，模型读不到)，所以这里给出逐页文字。
 */
async function readPdfText(
  absPath: string,
  pages: string | undefined,
  extract: PdfTextExtractor | undefined,
  displayPath = absPath,
): Promise<ToolResult> {
  if (!extract) {
    return textResult('Reading PDF files is not available here. Extract the text with Bash (for example pdftotext) instead.', true);
  }
  const requested = pages === undefined || pages.trim() === '' ? null : parsePdfPageRange(pages);
  if (pages !== undefined && pages.trim() !== '' && !requested) {
    return textResult(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`, true);
  }
  const range = requested ?? { first: 1, last: CC_PDF_MAX_PAGES_PER_READ };
  if (range.last - range.first + 1 > CC_PDF_MAX_PAGES_PER_READ) {
    return textResult(`Page range "${pages}" exceeds the maximum of ${CC_PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`, true);
  }
  const data = await fsp.readFile(absPath);
  const extracted = await extract(new Uint8Array(data), range.last, CC_PDF_MAX_CHARS);
  if (range.first > extracted.numPages) {
    return textResult(`The PDF has ${extracted.numPages} page(s); page ${range.first} does not exist.`, true);
  }
  const lastRead = Math.min(range.last, extracted.pagesInspected);
  const sections = extracted.sections.flatMap((section) => {
    const match = /^--- 第 (\d+) 页 ---\n/.exec(section);
    if (!match || Number(match[1]) < range.first) return [];
    return [`--- Page ${match[1]} ---\n${section.slice(match[0].length)}`];
  });
  const notes = [
    `PDF ${displayPath}: ${extracted.numPages} page(s). Text of pages ${range.first}-${lastRead} follows; images, layout and scanned pages are not included.`,
  ];
  if (!requested && extracted.numPages > lastRead) {
    notes.push(`Use the pages parameter (for example "${lastRead + 1}-${Math.min(extracted.numPages, lastRead + CC_PDF_MAX_PAGES_PER_READ)}") to read more.`);
  }
  if (extracted.clipped) notes.push('The text was cut off at the size limit; read a smaller page range to see the rest.');
  if (!sections.length) notes.push('These pages have no extractable text (they may be scanned images).');
  return textResult([notes.join(' '), ...sections].join('\n\n'));
}

export async function ccRead(
  absPath: string,
  input: CcReadInput,
  readState: ReadStateTracker,
  cwd: string,
  extractPdfText?: PdfTextExtractor,
  displayPath = absPath,
): Promise<ToolResult> {
  const stat = await statOrNull(absPath);
  if (!stat) {
    return textResult(`File does not exist. Note: your current working directory is ${cwd}.`, true);
  }
  if (stat.isDirectory()) {
    return textResult(`EISDIR: illegal operation on a directory, read '${displayPath}'. Use Bash with ls to list a directory.`, true);
  }
  const ext = path.extname(absPath).toLowerCase();
  if (IMAGE_MIME[ext] || CONVERTIBLE_IMAGE_EXTENSIONS.has(ext)) {
    const result = await readImage(absPath);
    readState.record(absPath, stat.mtimeMs);
    return result;
  }
  if (ext === '.pdf') {
    if (stat.size > CC_PDF_MAX_BYTES) return textResult(`PDF is too large to read (${stat.size} bytes).`, true);
    const result = await readPdfText(absPath, input.pages, extractPdfText, displayPath);
    if (!result.isError) readState.record(absPath, stat.mtimeMs);
    return result;
  }
  if (ext === '.ipynb') {
    const raw = await fsp.readFile(absPath, 'utf8');
    readState.record(absPath, stat.mtimeMs);
    return textResult(renderNotebook(raw));
  }
  const hasRange = input.offset !== undefined || input.limit !== undefined;
  if (!hasRange && stat.size > CC_READ_MAX_FULL_BYTES) {
    return textResult(
      `File content (${Math.round(stat.size / 1024)}KB) exceeds maximum allowed size (${CC_READ_MAX_FULL_BYTES / 1024}KB). Please use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      true,
    );
  }
  if (stat.size === 0) {
    readState.record(absPath, stat.mtimeMs);
    return textResult('<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>');
  }
  const start = Math.max(1, Math.floor(input.offset ?? 1) || 1);
  const limit = Math.max(1, Math.floor(input.limit ?? CC_READ_DEFAULT_LIMIT) || CC_READ_DEFAULT_LIMIT);
  const { lines, total } = await readLineRange(absPath, start, limit);
  readState.record(absPath, stat.mtimeMs);
  if (lines.length === 0) {
    return textResult(
      `<system-reminder>Warning: the file exists but is shorter than the provided offset (${start}). The file has ${total} lines.</system-reminder>`,
    );
  }
  return textResult(formatNumberedLines(lines, start));
}

/** 逐行读取 [start, start+limit) 行(1 起)，同时数出总行数；大文件不整读进内存。 */
async function readLineRange(absPath: string, start: number, limit: number): Promise<{ lines: string[]; total: number }> {
  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let total = 0;
  try {
    for await (const line of reader) {
      total += 1;
      if (total >= start && lines.length < limit) lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines, total };
}

async function readImage(absPath: string): Promise<ToolResult> {
  let target = absPath;
  try {
    target = await getDefaultImageResizer().process(absPath);
  } catch {
    target = absPath;
  }
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()] ?? (await detectImageMime(target));
  if (!mime) return textResult(`Unsupported image format: ${path.extname(absPath) || 'unknown'}.`, true);
  const data = await fsp.readFile(target);
  if (data.length > CC_IMAGE_MAX_BYTES) {
    return textResult(`Image is too large to send to the model (${data.length} bytes).`, true);
  }
  return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
}

interface NotebookCell {
  id?: string;
  cell_type?: string;
  source?: string | string[];
  outputs?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
}

interface Notebook {
  cells?: NotebookCell[];
  metadata?: { language_info?: { name?: string } };
  nbformat?: number;
  nbformat_minor?: number;
}

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
}

function cellId(cell: NotebookCell, index: number): string {
  return typeof cell.id === 'string' && cell.id ? cell.id : `cell-${index}`;
}

function outputText(output: Record<string, unknown>): string {
  const text = output.text;
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.join('');
  const data = output.data as Record<string, unknown> | undefined;
  const plain = data?.['text/plain'];
  if (typeof plain === 'string') return plain;
  if (Array.isArray(plain)) return plain.join('');
  if (data && Object.keys(data).some((key) => key.startsWith('image/'))) return '[image output]';
  if (typeof output.ename === 'string') return `${output.ename}: ${String(output.evalue ?? '')}`;
  return '';
}

function renderNotebook(raw: string): string {
  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw) as Notebook;
  } catch {
    return raw;
  }
  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  if (cells.length === 0) return '<system-reminder>Warning: the notebook has no cells.</system-reminder>';
  return cells.map((cell, index) => {
    const outputs = (cell.outputs ?? []).map(outputText).filter(Boolean).join('\n');
    return [
      `<cell id="${cellId(cell, index)}"><cell_type>${cell.cell_type ?? 'code'}</cell_type>`,
      cellSource(cell),
      outputs ? `<outputs>\n${outputs}\n</outputs>` : '',
      '</cell>',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

export interface FileWriteHooks {
  /** 写入已知文件前调用(每轮改动对比抓取改前内容)。 */
  beforeWrite(absPath: string): Promise<void>;
}

export async function ccWrite(
  absPath: string,
  content: string,
  readState: ReadStateTracker,
  hooks: FileWriteHooks,
  displayPath = absPath,
): Promise<ToolResult> {
  const stat = await statOrNull(absPath);
  if (stat?.isDirectory()) return textResult(`EISDIR: illegal operation on a directory, write '${displayPath}'`, true);
  if (stat) {
    const problem = await readState.check(absPath);
    if (problem) return textResult(problem, true);
  }
  await hooks.beforeWrite(absPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, 'utf8');
  const after = await fsp.stat(absPath);
  readState.record(absPath, after.mtimeMs);
  return textResult(stat ? `The file ${displayPath} has been updated successfully.` : `File created successfully at: ${displayPath}`);
}

export interface CcEditInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export async function ccEdit(
  absPath: string,
  input: CcEditInput,
  readState: ReadStateTracker,
  hooks: FileWriteHooks,
  displayPath = absPath,
): Promise<ToolResult> {
  const { old_string: oldString, new_string: newString } = input;
  if (oldString === newString) {
    return textResult('No changes to make: old_string and new_string are exactly the same.', true);
  }
  const stat = await statOrNull(absPath);
  if (stat?.isDirectory()) return textResult(`EISDIR: illegal operation on a directory, edit '${displayPath}'`, true);
  if (!stat) {
    if (oldString !== '') return textResult(`File does not exist: ${displayPath}`, true);
    await hooks.beforeWrite(absPath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, newString, 'utf8');
    readState.record(absPath, (await fsp.stat(absPath)).mtimeMs);
    return textResult(`File created successfully at: ${displayPath}`);
  }
  const problem = await readState.check(absPath);
  if (problem) return textResult(problem, true);
  const original = await fsp.readFile(absPath, 'utf8');
  if (oldString === '') {
    if (original.trim() !== '') return textResult('Cannot create new file - file already exists.', true);
    await hooks.beforeWrite(absPath);
    await fsp.writeFile(absPath, newString, 'utf8');
    readState.record(absPath, (await fsp.stat(absPath)).mtimeMs);
    return textResult(`The file ${displayPath} has been updated successfully.`);
  }
  // 文件用 CRLF 时按 LF 匹配，写回时恢复原换行风格。
  const crlf = original.includes('\r\n');
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const needle = crlf ? oldString.replace(/\r\n/g, '\n') : oldString;
  const replacement = crlf ? newString.replace(/\r\n/g, '\n') : newString;
  const matches = countOccurrences(text, needle);
  if (matches === 0) {
    return textResult(`String to replace not found in file.\nString: ${oldString}`, true);
  }
  if (matches > 1 && !input.replace_all) {
    return textResult(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
      true,
    );
  }
  const updated = input.replace_all ? text.split(needle).join(replacement) : text.replace(needle, () => replacement);
  await hooks.beforeWrite(absPath);
  await fsp.writeFile(absPath, crlf ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
  readState.record(absPath, (await fsp.stat(absPath)).mtimeMs);
  return textResult(`The file ${displayPath} has been updated successfully.`);
}

export interface CcNotebookEditInput {
  cell_id?: string;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

function findCellIndex(cells: NotebookCell[], id: string): number {
  const exact = cells.findIndex((cell) => cell.id === id);
  if (exact >= 0) return exact;
  const numbered = /^cell-(\d+)$/.exec(id);
  if (numbered) {
    const index = Number(numbered[1]);
    if (index < cells.length) return index;
  }
  return -1;
}

function detectIndent(raw: string): number {
  const match = /^\{\s*\n( +)"/.exec(raw);
  return match ? match[1].length : 1;
}

function newCellId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

export async function ccNotebookEdit(
  absPath: string,
  input: CcNotebookEditInput,
  readState: ReadStateTracker,
  hooks: FileWriteHooks,
): Promise<ToolResult> {
  if (path.extname(absPath).toLowerCase() !== '.ipynb') {
    return textResult('File must be a Jupyter notebook (.ipynb file). For editing other file types, use the Edit tool.', true);
  }
  const stat = await statOrNull(absPath);
  if (!stat) return textResult('Notebook file does not exist.', true);
  const problem = await readState.check(absPath);
  if (problem) return textResult(problem, true);
  const raw = await fsp.readFile(absPath, 'utf8');
  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw) as Notebook;
  } catch {
    return textResult('Notebook is not valid JSON.', true);
  }
  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  notebook.cells = cells;
  const mode = input.edit_mode ?? 'replace';
  const index = input.cell_id ? findCellIndex(cells, input.cell_id) : -1;
  if (mode !== 'insert' && index < 0) {
    return textResult(input.cell_id ? `Cell with ID "${input.cell_id}" not found in notebook.` : 'cell_id is required for replace and delete.', true);
  }
  if (mode === 'insert' && input.cell_id && index < 0) {
    return textResult(`Cell with ID "${input.cell_id}" not found in notebook.`, true);
  }
  if (mode === 'insert' && !input.cell_type) {
    return textResult('cell_type is required when using edit_mode=insert.', true);
  }
  const supportsIds = (notebook.nbformat ?? 4) > 4 || ((notebook.nbformat ?? 4) === 4 && (notebook.nbformat_minor ?? 0) >= 5);
  let resultId = input.cell_id ?? '';
  if (mode === 'delete') {
    cells.splice(index, 1);
  } else if (mode === 'insert') {
    const cellType = input.cell_type ?? 'code';
    const cell: NotebookCell = cellType === 'markdown'
      ? { cell_type: 'markdown', metadata: {}, source: input.new_source }
      : { cell_type: 'code', metadata: {}, source: input.new_source, outputs: [], execution_count: null };
    if (supportsIds) {
      cell.id = newCellId();
      resultId = cell.id;
    }
    cells.splice(index + 1, 0, cell);
  } else {
    const cell = cells[index];
    cell.source = input.new_source;
    if (input.cell_type && input.cell_type !== cell.cell_type) {
      cell.cell_type = input.cell_type;
      if (input.cell_type === 'markdown') {
        delete cell.outputs;
        delete cell.execution_count;
      } else {
        cell.outputs = [];
        cell.execution_count = null;
      }
    } else if (cell.cell_type === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
  }
  await hooks.beforeWrite(absPath);
  await fsp.writeFile(absPath, `${JSON.stringify(notebook, null, detectIndent(raw))}\n`, 'utf8');
  readState.record(absPath, (await fsp.stat(absPath)).mtimeMs);
  const verb = mode === 'delete' ? 'Deleted cell' : mode === 'insert' ? 'Inserted cell' : 'Updated cell';
  return textResult(`${verb} ${resultId}`.trim());
}
