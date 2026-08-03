/**
 * watch — daemon 端的 workdir 文件监听(P4)。
 *
 * 实现选型:Node 内建 `fs.watch(dir, { recursive: true })`。
 *  - 远端跑在 bundled Node(≥22)上,Linux(inotify 递归模拟)/ macOS(FSEvents)
 *    都原生支持 recursive;不引原生依赖(@parcel/watcher 的 prebuilt .node
 *    进不了 esbuild 单文件 bundle,这正是它留在 desktop 侧的原因)。
 *  - fs.watch 只报 'rename' | 'change' + 相对 filename:'rename' 不区分
 *    add/unlink,用一次 lstat 判存在性映射到 FileTreeEvent 的 add/unlink。
 *
 * 过滤(与 desktop 本地 watcher 同语义):
 *  - ignore matcher(.gitignore + builtin)兜底,file/dir 双查任一命中即丢;
 *  - `.xdt-tmp` 原子写中间产物直接丢(防前端 ghost row);
 *  - 50ms 窗口按 (type, relPath) coalesce,吸收 agent 批量写盘的事件风暴——
 *    消费端(desktop → renderer fetchDir)按父目录 refetch,重复事件只是
 *    浪费 IPC,合并无语义损失。
 *
 * 生命周期:per-workdir 单 watcher(重复 watchStart 幂等);stdin EOF /
 * watchStop 时 close。事件经注入的 emit 回调发 `fileTree` 帧。
 */

import { watch as fsWatch, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  loadIgnoreMatcher,
  scopedLogger,
  XDT_TMP_SUFFIX,
  type Matcher,
} from '@cindy/file-browser-core';

const log = scopedLogger('file-service/watch');

export interface RemoteFileTreeEvent {
  workdir: string;
  type: 'add' | 'change' | 'unlink';
  /** workdir-relative POSIX path */
  relPath: string;
}

interface WatchEntry {
  watcher: FSWatcher;
  matcher: Matcher;
  /** coalesce 缓冲:key = `${type}::${relPath}`。 */
  pending: Map<string, RemoteFileTreeEvent>;
  flushTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  pollSnapshot: Map<string, string> | null;
  polling: boolean;
  pollInFlight: boolean;
}

const COALESCE_MS = 50;
const FALLBACK_POLL_MS = 250;
const WATCH_RESOURCE_ERRORS = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);

export class WorkdirWatchManager {
  private readonly entries = new Map<string, WatchEntry>();
  /** 启动中的 workdir:has 判定与 entries.set 之间隔着 loadIgnoreMatcher 的
   *  await,并发 start(双窗口 / 重连 replay)会双双通过判定,各建一个原生
   *  watcher——事件双份、先建的那个 watchStop 够不着直到 daemon 退出。
   *  并发请求 piggyback 同一个启动 promise。 */
  private readonly starting = new Map<string, Promise<void>>();
  /** 启动窗口内收到 stop 的 workdir:startInner 完成时不装 watcher(装完即拆),
   *  否则快速开关文件浏览会留下无人再来 stop 的孤儿原生 watcher。 */
  private readonly stopDuringStart = new Set<string>();
  private readonly emit: (event: RemoteFileTreeEvent) => void;

  constructor(emit: (event: RemoteFileTreeEvent) => void) {
    this.emit = emit;
  }

  /** 幂等启动。matcher 加载失败 / fs.watch 抛错向上冒(RPC 返回 OPERATION_FAILED)。 */
  async start(workdir: string, opts: { hideMetaFiles?: boolean } = {}): Promise<void> {
    if (this.entries.has(workdir)) return;
    const inflight = this.starting.get(workdir);
    if (inflight) return inflight;
    const run = this.startInner(workdir, opts);
    this.starting.set(workdir, run);
    try {
      await run;
    } finally {
      this.starting.delete(workdir);
      this.stopDuringStart.delete(workdir);
    }
  }

  private async startInner(workdir: string, opts: { hideMetaFiles?: boolean }): Promise<void> {
    const matcher = await loadIgnoreMatcher(workdir, {
      hideMetaFiles: opts.hideMetaFiles ?? true,
      honorVcsIgnore: false,
    });

    const entry: WatchEntry = {
      watcher: null as unknown as FSWatcher,
      matcher,
      pending: new Map(),
      flushTimer: null,
      pollTimer: null,
      pollSnapshot: null,
      polling: false,
      pollInFlight: false,
    };
    const watcher = fsWatch(workdir, { recursive: true }, (eventType, filename) => {
      // filename 偶发 null(平台边缘情况),无法定位目标 — 丢弃,聚焦刷新兜底。
      if (!filename) return;
      void this.handleRaw(workdir, entry, eventType, filename.toString());
    });
    watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && WATCH_RESOURCE_ERRORS.has(code)) {
        log.warn('fs.watch resource exhausted, switching to polling', workdir, code);
        void this.startPollingFallback(workdir, entry);
        return;
      }
      // watcher 挂了(权限 / 目录被删):log 后移除,消费端靠手动刷新。
      log.warn('fs.watch error, dropping watcher', workdir, String(err));
      this.stop(workdir);
    });
    entry.watcher = watcher;
    if (this.stopDuringStart.delete(workdir)) {
      // 启动期间来了 stop(调用方的登记已清,不会再发第二次 stop):当场拆掉。
      try {
        watcher.close();
      } catch {
        // already closed
      }
      log.info('watch start cancelled by stop during startup', workdir);
      return;
    }
    this.entries.set(workdir, entry);
    log.info('watch started', workdir);
  }

  stop(workdir: string): void {
    // 还在启动窗口:打标记让 startInner 完成时自拆(entries 里此刻还没有它)。
    if (this.starting.has(workdir)) this.stopDuringStart.add(workdir);
    const entry = this.entries.get(workdir);
    if (!entry) return;
    this.entries.delete(workdir);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    log.info('watch stopped', workdir);
  }

  /**
   * macOS FSEvents / Linux inotify 的进程或系统额度耗尽时，fs.watch 会在构造成功后
   * 异步报 EMFILE/ENFILE/ENOSPC。旧实现只移除 watcher，客户端却已经收到 start 成功，
   * 随后文件树永久不刷新。资源类错误改为低频快照 diff；正常环境仍走原生事件。
   */
  private async startPollingFallback(workdir: string, entry: WatchEntry): Promise<void> {
    if (this.entries.get(workdir) !== entry || entry.polling) return;
    entry.polling = true;
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    try {
      entry.pollSnapshot = await this.scanSnapshot(workdir, entry.matcher);
    } catch (err) {
      log.warn('polling fallback initial scan failed, dropping watcher', workdir, String(err));
      this.stop(workdir);
      return;
    }
    if (this.entries.get(workdir) !== entry) return;
    entry.pollTimer = setInterval(() => {
      if (entry.pollInFlight) return;
      entry.pollInFlight = true;
      void this.pollOnce(workdir, entry).finally(() => {
        entry.pollInFlight = false;
      });
    }, FALLBACK_POLL_MS);
    entry.pollTimer.unref?.();
    log.info('polling fallback started', workdir);
  }

  private async pollOnce(workdir: string, entry: WatchEntry): Promise<void> {
    if (this.entries.get(workdir) !== entry || !entry.pollSnapshot) return;
    let next: Map<string, string>;
    try {
      next = await this.scanSnapshot(workdir, entry.matcher);
    } catch (err) {
      log.warn('polling fallback scan failed', workdir, String(err));
      return;
    }
    if (this.entries.get(workdir) !== entry) return;
    const previous = entry.pollSnapshot;
    entry.pollSnapshot = next;
    for (const [relPath, signature] of next) {
      const oldSignature = previous.get(relPath);
      if (oldSignature === undefined) this.enqueue(entry, { workdir, type: 'add', relPath });
      else if (oldSignature !== signature) this.enqueue(entry, { workdir, type: 'change', relPath });
    }
    for (const relPath of previous.keys()) {
      if (!next.has(relPath)) this.enqueue(entry, { workdir, type: 'unlink', relPath });
    }
  }

  private async scanSnapshot(workdir: string, matcher: Matcher): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const visit = async (relativeDir: string): Promise<void> => {
      const absoluteDir = relativeDir ? path.join(workdir, relativeDir) : workdir;
      const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
      for (const dirent of dirents) {
        const relPath = relativeDir
          ? `${relativeDir.split(path.sep).join('/')}/${dirent.name}`
          : dirent.name;
        if (relPath.endsWith(XDT_TMP_SUFFIX)) continue;
        if (matcher.ignores(relPath, dirent.isDirectory())) continue;
        if (dirent.isDirectory()) {
          await visit(relPath);
          continue;
        }
        if (!dirent.isFile()) continue;
        const stat = await fs.stat(path.join(workdir, relPath));
        snapshot.set(relPath, `${stat.mtimeMs}:${stat.size}`);
      }
    };
    await visit('');
    return snapshot;
  }

  stopAll(): void {
    for (const workdir of [...this.starting.keys()]) this.stopDuringStart.add(workdir);
    for (const workdir of [...this.entries.keys()]) this.stop(workdir);
  }

  private async handleRaw(
    workdir: string,
    entry: WatchEntry,
    eventType: string,
    rawFilename: string,
  ): Promise<void> {
    const relPath = rawFilename.split(path.sep).join('/');
    if (relPath === '' || relPath.startsWith('..')) return;
    if (relPath.endsWith(XDT_TMP_SUFFIX)) return;
    // matcher 不知道路径是 file 还是 dir,双查任一命中即丢(同 desktop watcher)。
    if (entry.matcher.ignores(relPath, false) && entry.matcher.ignores(relPath, true)) return;

    let type: RemoteFileTreeEvent['type'];
    if (eventType === 'change') {
      type = 'change';
    } else {
      // 'rename' = add 或 unlink,lstat 判存在性。
      try {
        await fs.lstat(path.join(workdir, relPath));
        type = 'add';
      } catch {
        type = 'unlink';
      }
    }
    this.enqueue(entry, { workdir, type, relPath });
  }

  private enqueue(entry: WatchEntry, event: RemoteFileTreeEvent): void {
    entry.pending.set(`${event.type}::${event.relPath}`, event);
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      const batch = [...entry.pending.values()];
      entry.pending.clear();
      for (const evt of batch) this.emit(evt);
    }, COALESCE_MS);
    entry.flushTimer.unref?.();
  }
}
