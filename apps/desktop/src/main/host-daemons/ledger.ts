/**
 * host-daemons/ledger —— 「这条常驻任务是哪个任务留下的」的本机台账。
 *
 * 为什么不进 DB：这只是一份可重建的判定缓存（丢了最多重新追溯一次），而新建表
 * 要带 migration + schema 兼容义务。用 userData 下的独立 JSON，写侧原子替换。
 *
 * 两条记录：
 *  - `owners`：已确认归属。会话删除后仍然保留（title 是当时的快照），这正是本功能
 *    「删了任务也找得回来」的落点。
 *  - `misses`：某任务定义在某个 mtime 上追溯失败，就不再重复扫全库窗口；文件被
 *    改写（mtime 变化）后重新尝试。
 *  - `firstSeen`：没有定义文件的来源（crontab 条目）第一次被扫描到的时刻，用作归属
 *    回溯的锚点，否则每次扫描都会换一个锚点、归属记录永远对不上。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 归属记录。除「谁建的」之外还钉住**任务定义的身份**：同名同路径的任务被删掉后
 * 由别的程序重建时，mtime 与启动命令都会变，旧归属随之失效 —— 否则清单会凭一个
 * 名字就继承停止/删除权限。
 */
export interface HostDaemonOwnerRecord {
  sessionId: string;
  title: string | null;
  atMs: number;
  definitionMtimeMs: number;
  command: string;
}

interface LedgerFile {
  version: 1;
  owners: Record<string, HostDaemonOwnerRecord>;
  misses: Record<string, number>;
  firstSeen: Record<string, number>;
}

/**
 * 空台账必须是**新对象**。模块级常量做浅拷贝时只复制外层，`owners` / `misses`
 * 仍与常量共用：一个账号在没有台账文件时写进去的记录，会原样出现在下一个同样
 * 没有台账文件的账号里 —— 账号目录隔离挡不住这条内存路径。
 */
function emptyLedger(): LedgerFile {
  return { version: 1, owners: {}, misses: {}, firstSeen: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseLedger(raw: string): LedgerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLedger();
  }
  if (!isRecord(parsed)) return emptyLedger();

  const owners: Record<string, HostDaemonOwnerRecord> = {};
  if (isRecord(parsed.owners)) {
    for (const [id, value] of Object.entries(parsed.owners)) {
      if (!isRecord(value) || typeof value.sessionId !== 'string') continue;
      if (typeof value.atMs !== 'number' || !Number.isFinite(value.atMs)) continue;
      // 缺身份字段的旧记录无法核对定义，直接丢弃：宁可重新追溯，也不凭名字授权。
      if (typeof value.definitionMtimeMs !== 'number' || !Number.isFinite(value.definitionMtimeMs)) {
        continue;
      }
      if (typeof value.command !== 'string') continue;
      owners[id] = {
        sessionId: value.sessionId,
        title: typeof value.title === 'string' ? value.title : null,
        atMs: value.atMs,
        definitionMtimeMs: value.definitionMtimeMs,
        command: value.command,
      };
    }
  }

  const misses: Record<string, number> = {};
  if (isRecord(parsed.misses)) {
    for (const [id, value] of Object.entries(parsed.misses)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) misses[id] = value;
    }
  }

  const firstSeen: Record<string, number> = {};
  if (isRecord(parsed.firstSeen)) {
    for (const [id, value] of Object.entries(parsed.firstSeen)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) firstSeen[id] = value;
    }
  }

  return { version: 1, owners, misses, firstSeen };
}

export interface HostDaemonLedger {
  getOwner(id: string): HostDaemonOwnerRecord | null;
  setOwner(id: string, record: HostDaemonOwnerRecord): void;
  /** 定义已变或任务已删除时撤销授权。 */
  clearOwner(id: string): void;
  getMissMtime(id: string): number | null;
  setMissMtime(id: string, mtimeMs: number): void;
  /** 无定义文件的来源：首次扫描到的时刻（归属回溯锚点）。 */
  getFirstSeen(id: string): number | null;
  setFirstSeen(id: string, atMs: number): void;
  /**
   * 按当前账号把台账读进内存。读写一律异步：本模块的入口挂在列表 IPC 上，
   * 同步 I/O 会直接卡主线程（工程约定 §8.5）。读内存的 getter 仍是同步的。
   */
  ready(): Promise<void>;
  save(): Promise<void>;
}

export function createHostDaemonLedger(filePath: string | (() => string)): HostDaemonLedger {
  let state: LedgerFile | null = null;
  /** 内存态的代次：每改一次 +1；`written` 追上它才算已落盘。 */
  let generation = 0;
  let written = 0;
  let loadedPath: string | null = null;
  // 「当前账号的台账已经读过」：没读过时绝不落盘，否则会把空台账写成真台账。
  let loaded = false;
  let loading: { path: string; done: Promise<void> } | null = null;
  let saving: Promise<void> = Promise.resolve();

  /**
   * 台账按当前账号隔离（路径随账号变化）。路径变了就丢弃内存态：切号后旧账号的
   * 归属记录（含会话标题）不能被新账号读到，内存缓存也不能继续当旧数据用。
   */
  function currentPath(): string {
    return typeof filePath === 'function' ? filePath() : filePath;
  }

  function ensure(): LedgerFile {
    const path = currentPath();
    if (state && loadedPath === path) return state;
    // 切号但还没 ready()：退回空台账。本轮结论由调用方的账号作用域守卫整批丢弃
    // （见 service.ts 的 scopeStamp），所以这里读不到旧账号的数据也不会误授权。
    state = emptyLedger();
    loadedPath = path;
    loaded = false;
    written = generation;
    return state;
  }

  function ready(): Promise<void> {
    const path = currentPath();
    if (loaded && loadedPath === path) return Promise.resolve();
    // 并发的读盘共用一次：各自读会互相清空内存态，后读完的把先读完之后写进去的记录丢掉。
    if (loading?.path === path) return loading.done;
    const flight = { path, done: Promise.resolve() };
    flight.done = (async () => {
      let next: LedgerFile;
      try {
        next = parseLedger(await readFile(path, 'utf8'));
      } catch {
        // 文件不存在 = 首次运行；损坏 = 当成空台账重来（判定可重建，不阻塞面板）。
        next = emptyLedger();
      }
      if (loading === flight) loading = null;
      // 读盘途中切了号：这批是旧账号的数据，不能装进当前内存态。
      if (currentPath() !== path) return;
      state = next;
      loadedPath = path;
      loaded = true;
      written = generation;
    })();
    loading = flight;
    return flight.done;
  }

  /**
   * 台账是可重建的判定缓存，所以写侧只要「整文件替换」的原子性，不需要 .bak 交换：
   * 丢的只是一轮判定结论，下次扫描会重算。
   */
  async function flush(): Promise<void> {
    const path = currentPath();
    // 没读过当前账号的台账绝不落盘；没有改动也不写。
    if (!loaded || loadedPath !== path || written === generation) return;
    const snapshot = generation;
    // 内容在任何 await 之前取定：写盘途中切号时 ensure() 已是新账号的空台账，不能写进旧账号的路径。
    const content = `${JSON.stringify(ensure(), null, 2)}\n`;
    const temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, content, { mode: 0o600 });
    try {
      await rename(temp, path);
    } catch (error) {
      // 目标正被别的进程占用时，Windows 的 rename 会失败（EPERM / EEXIST）。不重试等待，
      // 退回先删后改名；这两步之间不原子，再失败就按保存失败报错。
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') {
        await rm(temp, { force: true });
        throw error;
      }
      await rm(path, { force: true });
      await rename(temp, path);
    }
    // 写盘途中又有改动时不能标成已落盘：那批改动留给下一次保存。
    written = snapshot;
  }

  /**
   * 保存排队执行：两次并发保存各自整文件替换，Windows 回退路径还要先删目标再改名，
   * 交错时会出现带着旧快照覆盖新记录、或文件暂时不存在的窗口。
   */
  function save(): Promise<void> {
    const run = saving.then(flush, flush);
    saving = run.catch(() => {});
    return run;
  }

  return {
    getOwner(id) {
      return ensure().owners[id] ?? null;
    },
    setOwner(id, record) {
      const current = ensure();
      current.owners[id] = record;
      delete current.misses[id];
      generation += 1;
    },
    clearOwner(id) {
      const current = ensure();
      if (!current.owners[id]) return;
      delete current.owners[id];
      generation += 1;
    },
    getMissMtime(id) {
      return ensure().misses[id] ?? null;
    },
    setMissMtime(id, mtimeMs) {
      ensure().misses[id] = mtimeMs;
      generation += 1;
    },
    getFirstSeen(id) {
      return ensure().firstSeen[id] ?? null;
    },
    setFirstSeen(id, atMs) {
      ensure().firstSeen[id] = atMs;
      generation += 1;
    },
    ready,
    save,
  };
}
