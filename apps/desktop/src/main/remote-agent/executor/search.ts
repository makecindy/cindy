/**
 * Pi grep 的本机后端：用 Cindy 自带的 ripgrep 在本机项目里搜索，输出格式与 Pi 自带 grep 一致
 * (`路径:行号: 内容`，上下文行用 `-`)，命中上限、长行截断、总量截断的提示也一致。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

/** 与 Pi 自带 grep 相同的默认值。 */
const DEFAULT_LIMIT = 100;
const MAX_LINE_CHARS = 500;
const MAX_OUTPUT_BYTES = 50 * 1024;

export interface PiGrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface PiGrepResult {
  text: string;
  details?: {
    matchLimitReached?: number;
    linesTruncated?: true;
    truncated?: true;
  };
}

function truncateLine(line: string): { text: string; truncated: boolean } {
  return line.length > MAX_LINE_CHARS
    ? { text: `${line.slice(0, MAX_LINE_CHARS)}... [truncated]`, truncated: true }
    : { text: line, truncated: false };
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
}

interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

export async function piGrep(
  rgPath: string,
  root: string,
  input: PiGrepInput,
  signal?: AbortSignal,
): Promise<PiGrepResult> {
  const stat = await fsp.stat(root);
  const rootIsDirectory = stat.isDirectory();
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const context = input.context && input.context > 0 ? Math.floor(input.context) : 0;
  const args = ['--json', '--hidden', '--glob', '!.git'];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.literal) args.push('--fixed-strings');
  if (context > 0) args.push('--context', String(context));
  if (input.glob) args.push('--glob', input.glob);
  args.push('--regexp', input.pattern, '--', rootIsDirectory ? '.' : path.basename(root));
  const cwd = rootIsDirectory ? root : path.dirname(root);

  const outputLines: string[] = [];
  let matches = 0;
  let limitReached = false;
  let linesTruncated = false;
  let stderr = '';
  let lastPath: string | undefined;
  let lastLine = -1;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const reader = readline.createInterface({ input: child.stdout });
    let stopped = false;
    reader.on('line', (raw) => {
      if (stopped) return;
      let event: RgEvent;
      try {
        event = JSON.parse(raw) as RgEvent;
      } catch {
        return;
      }
      if (event.type !== 'match' && event.type !== 'context') return;
      const file = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (!file || typeof lineNumber !== 'number') return;
      // rg 的路径在 Windows 上是 `.` 开头的反斜杠形式(`.\src\a.ts`)，统一剥掉前缀并转正斜杠。
      const display = rootIsDirectory ? file.replace(/^\.[\\/]/, '').split(/[\\/]/).join('/') : path.basename(root);
      if (lastPath !== undefined && (display !== lastPath || lineNumber > lastLine + 1) && context > 0) {
        outputLines.push('--');
      }
      lastPath = display;
      lastLine = lineNumber;
      const text = (event.data?.lines?.text ?? '').replace(/\r?\n$/, '').replace(/\r/g, '');
      const { text: shown, truncated } = truncateLine(text);
      if (truncated) linesTruncated = true;
      const separator = event.type === 'match' ? ':' : '-';
      outputLines.push(`${display}${separator}${lineNumber}${separator} ${shown}`);
      if (event.type === 'match') {
        matches += 1;
        if (matches >= limit) {
          limitReached = true;
          stopped = true;
          child.kill();
        }
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
      if (!limitReached && code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`));
        return;
      }
      resolve();
    });
  });

  if (matches === 0) return { text: 'No matches found' };
  // 上下文模式下最后一条可能是命中后的上下文，按出现顺序保留。
  let output = outputLines.join('\n');
  let truncated = false;
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    const kept: string[] = [];
    let size = 0;
    for (const line of outputLines) {
      const next = Buffer.byteLength(line) + 1;
      if (size + next > MAX_OUTPUT_BYTES) break;
      kept.push(line);
      size += next;
    }
    output = kept.join('\n');
    truncated = true;
  }
  const notices: string[] = [];
  const details: NonNullable<PiGrepResult['details']> = {};
  if (limitReached) {
    notices.push(`${limit} matches limit reached`);
    details.matchLimitReached = limit;
  }
  if (linesTruncated) {
    notices.push('long lines truncated');
    details.linesTruncated = true;
  }
  if (truncated) {
    notices.push(`${formatSize(MAX_OUTPUT_BYTES)} limit reached`);
    details.truncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
  return { text: output, ...(Object.keys(details).length > 0 ? { details } : {}) };
}
