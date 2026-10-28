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
 */

import fs from 'node:fs';

import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

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
}

const EMPTY: LedgerFile = { version: 1, owners: {}, misses: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseLedger(raw: string): LedgerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (!isRecord(parsed)) return { ...EMPTY };

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

  return { version: 1, owners, misses };
}

export interface HostDaemonLedger {
  getOwner(id: string): HostDaemonOwnerRecord | null;
  setOwner(id: string, record: HostDaemonOwnerRecord): void;
  /** 定义已变或任务已删除时撤销授权。 */
  clearOwner(id: string): void;
  getMissMtime(id: string): number | null;
  setMissMtime(id: string, mtimeMs: number): void;
  save(): void;
}

export function createHostDaemonLedger(filePath: string): HostDaemonLedger {
  let state: LedgerFile | null = null;
  let dirty = false;

  function ensure(): LedgerFile {
    if (state) return state;
    try {
      state = parseLedger(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // 文件不存在 = 首次运行；损坏 = 当成空台账重来（判定可重建，不阻塞面板）。
      state = { ...EMPTY };
    }
    return state;
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
    save() {
      if (!dirty) return;
      atomicWriteFileSync(filePath, `${JSON.stringify(ensure(), null, 2)}\n`);
      dirty = false;
    },
  };
}
