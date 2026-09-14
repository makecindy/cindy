/**
 * RipgrepSearcher — 包装 ripgrep 子进程的纯类。
 *
 * 设计原则:
 *  - 不依赖 electron / IPC / 渲染层,只负责 spawn rg、按行 parse NDJSON、
 *    通过 EventEmitter 抛 match/end/error。上层(IPC index.ts)负责把事件
 *    转成 webContents.send。
 *  - 一个 Searcher 实例可以同时跑多个 search(每次 start 返回一个 searchId,
 *    内部用 Map<id, ChildProcess> 管理生命周期)。
 *  - 取消 = SIGTERM 子进程,再加 200ms 兜底 SIGKILL,防止 rg 卡在某些大文件。
 *  - 全局 maxMatches 上限通过累计计数控制(rg 自己只支持 per-file --max-count),
 *    达到上限后主动 kill 并 emit end({ truncated: true })。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SUPPORTED_TEXT_EXTS,
  KNOWN_TEXT_FILENAMES,
} from '../textFileExts.js';
import type { SearchEvent, SearchMatch, SearchQuery } from './types.js';

/**
 * 文本/代码/markdown 文件白名单的 rg --glob 形式,在 spawn 时一次性算出来。
 *
 *  - 扩展名(含 dotfile 形态如 .gitignore)→ `*EXT`,带 leading dot 的全名
 *    (`.env.example` 等多段扩展)也走 `*.foo.bar` 这种形式。`*` 可匹配空,
 *    所以 `*.gitignore` 既匹配 `.gitignore` 也匹配 `foo.gitignore`。
 *  - 无扩展名特殊文件名(Dockerfile / Makefile 等)→ 直接用文件名匹配,且
 *    通过 `--iglob` 跨 OS 大小写不敏感(Dockerfile / dockerfile 都收)。
 *  - rg 把多个 --glob 当 union 处理,只要文件命中任一 pattern 就纳入搜索。
 *
 * 维护这份白名单的真源在 src/shared/textFileExts.ts;那边新增扩展名,这里
 * 自动生效,不要在这里另起一套硬编码。
 */
const TEXT_FILE_GLOB_ARGS: string[] = (() => {
  const args: string[] = [];
  for (const ext of SUPPORTED_TEXT_EXTS) {
    // ext 形如 ".ts" / ".gitignore" / ".env.example"
    args.push('--glob', `*${ext}`);
  }
  for (const name of KNOWN_TEXT_FILENAMES) {
    args.push('--iglob', name);
  }
  return args;
})();

/** rg --json 单行 NDJSON 的关心字段(rg 实际输出更多 type, 我们只 parse 这几个)。 */
interface RgJsonBegin {
  type: 'begin';
  data: { path: { text?: string } | { bytes: string } };
}
interface RgJsonMatch {
  type: 'match';
  data: {
    path: { text?: string } | { bytes: string };
    lines: { text?: string } | { bytes: string };
    line_number: number;
    submatches: Array<{
      match: { text?: string } | { bytes: string };
      start: number;
      end: number;
    }>;
  };
}
interface RgJsonSummary {
  type: 'summary';
  data: { stats: { matches: number }; elapsed_total: { human: string } };
}
type RgJsonLine = RgJsonBegin | RgJsonMatch | RgJsonSummary | { type: string };

/**
 * 极简 logger 接口 - 让 RipgrepSearcher 不直接依赖 main/logger.ts (保持纯类),
 * 由 IPC 层把 createLogger('file-browser/search') 注入进来。
 */
export interface SearcherLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

interface ActiveSearch {
  child: ChildProcessWithoutNullStreams;
  reader: ReadlineInterface;
  query: SearchQuery;
  matchCount: number;
  fileCount: number;
  ended: boolean;
}

/** 强制终止子进程的 fallback 间隔: SIGTERM 后还没退就 SIGKILL。 */
const KILL_GRACE_MS = 200;

export interface RipgrepSearcherOptions {
  rgPath: string;
  logger: SearcherLogger;
}

export class RipgrepSearcher extends EventEmitter {
  private readonly rgPath: string;
  private readonly log: SearcherLogger;
  private readonly active = new Map<string, ActiveSearch>();

  constructor(opts: RipgrepSearcherOptions) {
    super();
    this.rgPath = opts.rgPath;
    this.log = opts.logger;
  }

  /**
   * 启动一次搜索。返回 searchId,所有后续 match/end/error 事件都带这个 id。
   * 调用方拿到 id 后可以随时 cancel。
   */
  start(query: SearchQuery): string {
    const searchId = randomUUID();

    // rg flag 选择:
    //   --json           NDJSON 输出
    //   -F               fixed-string (不开正则,用户输入啥就是啥)
    //   --max-count=200  per-file 上限 (防单文件占完全局配额)
    //   --hidden         遍历 .开头文件,但 .gitignore 仍生效
    //   --glob/--iglob   只在文本/代码/markdown 文件里搜 (TEXT_FILE_GLOB_ARGS),
    //                    rg 默认虽然会跳过二进制,但 .docx/.xlsx/未知扩展名 之类
    //                    走 binary detect 不一定准,所以走显式白名单确保搜索范围
    //                    和附件系统对 "文本文件" 的定义一致。.gitignore 仍生效,
    //                    白名单是叠加过滤。
    //   -i               不区分大小写 (caseSensitive=false 时加)
    //   --               终止 flag 解析,后面是 query + path
    const args = [
      '--json',
      '-F',
      '--max-count=200',
      '--hidden',
      ...TEXT_FILE_GLOB_ARGS,
    ];
    if (!query.caseSensitive) args.push('-i');
    args.push('--', query.query, query.workdir);

    this.log.debug('rg spawn', { searchId, query: query.query, caseSensitive: query.caseSensitive });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.rgPath, args, {
        cwd: query.workdir,
        // stdio: pipe (默认),需要读 stdout 流式 parse。
        // windowsHide: true 防 Windows 下 spawn 弹出 cmd 黑框。
        windowsHide: true,
      });
    } catch (err) {
      this.log.error('rg spawn failed', { searchId, error: String(err) });
      // 同步失败:延一拍再 emit 让 caller 有机会拿到 id 后注册监听。
      queueMicrotask(() => {
        this.emit('event', {
          type: 'error',
          searchId,
          message: `rg spawn failed: ${String(err)}`,
        } satisfies SearchEvent);
      });
      return searchId;
    }

    const reader = createInterface({ input: child.stdout });
    const seenFiles = new Set<string>();

    const state: ActiveSearch = {
      child,
      reader,
      query,
      matchCount: 0,
      fileCount: 0,
      ended: false,
    };
    this.active.set(searchId, state);

    reader.on('line', (line) => {
      if (state.ended) return;
      if (!line) return;
      let parsed: RgJsonLine;
      try {
        parsed = JSON.parse(line) as RgJsonLine;
      } catch {
        // rg 偶尔会把一些非 JSON 信息 (e.g. "No such file") 走 stdout? 实际上
        // 不会 —— rg 错误信息走 stderr。这里拿到非 JSON 当噪音忽略。
        return;
      }
      if (parsed.type === 'begin') {
        const p = extractPath((parsed as RgJsonBegin).data.path);
        if (p && !seenFiles.has(p)) {
          seenFiles.add(p);
          state.fileCount += 1;
        }
        return;
      }
      if (parsed.type === 'match') {
        const m = toSearchMatch(searchId, parsed as RgJsonMatch, query.workdir);
        if (!m) return;
        state.matchCount += 1;
        this.emit('event', { type: 'match', ...m } satisfies SearchEvent);
        if (state.matchCount >= query.maxMatches) {
          this.log.debug('rg cap reached', { searchId, cap: query.maxMatches });
          this.finalize(searchId, true);
        }
        return;
      }
      // 'end' / 'summary' 等其它 type 不需要主动消费 —— 通过 child 'close' 事件
      // 收尾,以便和取消路径走同一段代码。
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.log.warn('rg stderr', { searchId, text });
    });

    child.on('error', (err) => {
      if (state.ended) return;
      this.log.error('rg child error', { searchId, error: String(err) });
      this.emit('event', {
        type: 'error',
        searchId,
        message: String(err),
      } satisfies SearchEvent);
      this.finalize(searchId, false);
    });

    child.on('close', (code, signal) => {
      if (state.ended) return;
      // rg 退出码: 0 = 有命中, 1 = 无命中, 2 = 致命错误。
      // signal 非空 = 被 OOM killer / SIGKILL 等意外终止(此时 code 为 null)。
      if (signal !== null) {
        this.log.warn('rg killed by signal', { searchId, signal });
        this.emitError(searchId, `ripgrep killed by signal ${signal}`);
        return;
      }
      if (code === 2) {
        this.log.warn('rg exited with fatal error', { searchId, code });
        this.emitError(searchId, `ripgrep exited with fatal error (code ${code})`);
        return;
      }
      if (code !== 0 && code !== 1) {
        this.log.warn('rg exited non-zero', { searchId, code });
      }
      this.finalize(searchId, false);
    });

    return searchId;
  }

  /** 取消指定搜索;若 id 不存在或已结束则 no-op。 */
  cancel(searchId: string): void {
    const state = this.active.get(searchId);
    if (!state || state.ended) return;
    this.log.debug('rg cancel', { searchId });
    this.killChild(state.child);
    this.finalize(searchId, false);
  }

  /** 取消所有活跃搜索(用于 window 关闭等清理场景)。 */
  cancelAll(): void {
    for (const id of Array.from(this.active.keys())) this.cancel(id);
  }

  /** Emit an error event and clean up the search state. */
  private emitError(searchId: string, message: string): void {
    const state = this.active.get(searchId);
    if (!state || state.ended) return;
    state.ended = true;
    try { state.reader.close(); } catch { /* ignore */ }
    this.killChild(state.child);
    this.active.delete(searchId);
    this.emit('event', {
      type: 'error',
      searchId,
      message,
    } satisfies SearchEvent);
  }

  private finalize(searchId: string, truncated: boolean): void {
    const state = this.active.get(searchId);
    if (!state || state.ended) return;
    state.ended = true;
    try { state.reader.close(); } catch { /* ignore */ }
    if (truncated) this.killChild(state.child);
    this.active.delete(searchId);
    this.emit('event', {
      type: 'end',
      searchId,
      truncated,
      totalMatches: state.matchCount,
      totalFiles: state.fileCount,
    } satisfies SearchEvent);
  }

  private killChild(child: ChildProcessWithoutNullStreams): void {
    if (child.killed || child.exitCode !== null) return;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, KILL_GRACE_MS).unref();
  }
}

function extractPath(p: { text?: string } | { bytes: string }): string | null {
  if ('text' in p && typeof p.text === 'string') return p.text;
  if ('bytes' in p) {
    try {
      return Buffer.from(p.bytes, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

function extractText(t: { text?: string } | { bytes: string }): string {
  if ('text' in t && typeof t.text === 'string') return t.text;
  if ('bytes' in t) {
    try {
      return Buffer.from(t.bytes, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

function toSearchMatch(
  searchId: string,
  m: RgJsonMatch,
  workdir: string,
): SearchMatch | null {
  const absPath = extractPath(m.data.path);
  if (!absPath) return null;
  // rg 输出的是绝对路径(我们 spawn 时传了绝对 workdir),剥成 workdir-relative POSIX。
  const rel = path.relative(workdir, absPath).split(path.sep).join('/');
  const lineText = extractText(m.data.lines).replace(/\r?\n$/, '');
  return {
    searchId,
    relPath: rel,
    lineNumber: m.data.line_number,
    lineText,
    submatches: m.data.submatches.map((s) => ({ start: s.start, end: s.end })),
  };
}
