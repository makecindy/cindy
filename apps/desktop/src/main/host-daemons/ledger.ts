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
import fs from 'node:fs';
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
  let dirty = false;
  let loadedPath: string | null = null;
  // 「当前账号的台账已经读过」：没读过时绝不落盘，否则会把空台账写成真台账。
  let loaded = false;

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
    dirty = false;
    return state;
  }

  async function ready(): Promise<void> {
    const path = currentPath();
    if (loaded && loadedPath === path) return;
    loadedPath = path;
    dirty = false;
    state = null;
    try {
      state = parseLedger(await readFile(path, 'utf8'));
    } catch {
      // 文件不存在 = 首次运行；损坏 = 当成空台账重来（判定可重建，不阻塞面板）。
      state = emptyLedger();
    }
    loaded = true;
  }

  /**
   * 台账是可重建的判定缓存，所以写侧只要「整文件替换」的原子性，不需要 .bak 交换：
   * 丢的只是一轮判定结论，下次扫描会重算。
   */
  async function save(): Promise<void> {
    if (!dirty || !loaded) return;
    const path = currentPath();
    if (loadedPath !== path) return;
    const temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify(ensure(), null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temp, path);
    } catch (error) {
      // Windows 不能 rename 覆盖已存在的目标文件。
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') {
        await rm(temp, { force: true });
        throw error;
      }
      await rm(path, { force: true });
      await rename(temp, path);
    }
    dirty = false;
  }

  return {
    getOwner(id) {
      return ensure().owners[id] ?? null;
    },
    setOwner(id, record) {
      const current = ensure();
      current.owners[id] = record;
      delete current.misses[id];
      dirty = true;
    },
    clearOwner(id) {
      const current = ensure();
      if (!current.owners[id]) return;
      delete current.owners[id];
      dirty = true;
    },
    getMissMtime(id) {
      return ensure().misses[id] ?? null;
    },
    setMissMtime(id, mtimeMs) {
      ensure().misses[id] = mtimeMs;
      dirty = true;
    },
    getFirstSeen(id) {
      return ensure().firstSeen[id] ?? null;
    },
    setFirstSeen(id, atMs) {
      ensure().firstSeen[id] = atMs;
      dirty = true;
    },
    ready,
    save,
  };
}
