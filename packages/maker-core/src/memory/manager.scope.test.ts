/**
 * MakerMemoryManager owner 作用域守卫 — issue #2341 修复的回归测试:
 *  - owner 缺失 (resolveBasePath → null) 必须 fail-closed 抛 memory:not-ready,
 *    绝不创建/写入 %TEMP% 式临时目录 (静默丢失根源);
 *  - ownerScopeKey 变化 (登录/登出/切账号) 必须关闭旧 store 池并重建到新根,
 *    杜绝旧 db 句柄与新 owner 数据混用;
 *  - 无 resolveBasePath/ownerScopeKey 的静态 basePath 宿主行为不变。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import { memoryScopeDirName } from './storage.js';
import type { Logger } from '../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

const WORKDIR = 'D:/repo/workdir';
const SCOPE_DIR = memoryScopeDirName(WORKDIR); // Windows: 'D--repo-workdir'
const memoryDirFor = (root: string) => path.join(root, 'maker-memory', SCOPE_DIR);

let rootA: string;
let rootB: string;

beforeEach(async () => {
  rootA = await mkdtemp(path.join(tmpdir(), 'memory-scope-a-'));
  rootB = await mkdtemp(path.join(tmpdir(), 'memory-scope-b-'));
});
afterEach(async () => {
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

/** 真 better-sqlite3, 并统计每个 open 的 db 的 close 次数 */
function trackingSqlite() {
  const closes: number[] = [];
  return {
    closes,
    factory: (filePath: string): Database.Database => {
      const db = new DatabaseCtor(filePath);
      const originalClose = db.close.bind(db);
      db.close = () => {
        closes.push(closes.length + 1);
        originalClose();
        return db; // better-sqlite3 声明 close(): this
      };
      return db;
    },
  };
}

describe('MakerMemoryManager · owner scope guard (#2341)', () => {
  it('owner 缺失时 getStore 抛 memory:not-ready, 且不创建任何存储目录', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => null, // 模拟 signed-out / 认证未落定
      ownerScopeKey: () => 'signed-out:none:0',
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    await expect(manager.getStore(WORKDIR)).rejects.toThrow(/memory:not-ready/);
    // 止血: 不得落盘 — 连 maker-memory 根目录都不该出现
    expect(existsSync(memoryDirFor(rootA))).toBe(false);
    expect(existsSync(path.join(rootA, 'maker-memory'))).toBe(false);
    expect(sqlite.closes).toHaveLength(0);
  });

  it('owner 缺失时 write / list 同路径 fail-closed (不经 getStore 成功)', async () => {
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => null,
      ownerScopeKey: () => 'signed-out:none:0',
      sqliteFactory: () => { throw new Error('must not open sqlite when owner missing'); },
      agents: {},
      logger: noopLogger,
    });

    await expect(
      manager.write(WORKDIR, {
        type: 'project',
        name: 'leak',
        title: '不应落盘',
        description: 'owner 缺失时禁止写临时库',
        body: 'xxx',
      }),
    ).rejects.toThrow(/memory:not-ready/);
    expect(existsSync(memoryDirFor(rootA))).toBe(false);
  });

  it('scope 稳定时复用同一 store 实例 (行为回归)', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => 'cloud:abc:1',
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    const store1 = await manager.getStore(WORKDIR);
    const store2 = await manager.getStore(WORKDIR);
    expect(store1).toBe(store2); // 同 scope 复用池内实例
    expect(sqlite.closes).toHaveLength(0); // 不应触发关闭
    manager.dispose();
  });

  it('scope 变化时关闭旧 db 并重建到新根 (owner 提交/切换)', async () => {
    let currentRoot = rootA;
    let currentScope = 'signed-out:none:0';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => currentRoot,
      ownerScopeKey: () => currentScope,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    // 首次 getStore → rootA 建库
    const storeA = await manager.getStore(WORKDIR);
    await storeA.write({
      type: 'project', name: 'note', title: 'A', description: 'desc', body: 'content-A',
    });
    expect(existsSync(memoryDirFor(rootA))).toBe(true);

    // owner 就绪/切换: root 与 scope 同时变化
    currentRoot = rootB;
    currentScope = 'cloud:abc:2';
    const storeB = await manager.getStore(WORKDIR);

    // 旧 store 的 db 已关闭, 新 store 指向新根且看不到旧数据
    expect(sqlite.closes.length).toBeGreaterThan(0);
    expect(storeB).not.toBe(storeA);
    expect((await storeB.list()).length).toBe(0);
    expect(existsSync(memoryDirFor(rootB))).toBe(true);

    // 再写一条 → 落在新根 (验证没有写回旧 owner 的库)
    await storeB.write({
      type: 'project', name: 'note-b', title: 'B', description: 'desc', body: 'content-B',
    });
    expect(existsSync(path.join(memoryDirFor(rootA), 'project_note.md'))).toBe(true);
    expect(existsSync(path.join(memoryDirFor(rootB), 'project_note-b.md'))).toBe(true);
    manager.dispose();
  });

  it('无 resolveBasePath/ownerScopeKey 的静态 basePath 宿主行为不变 (回归)', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    const store = await manager.getStore(WORKDIR);
    await store.write({
      type: 'project', name: 'plain', title: 'P', description: 'desc', body: 'content-P',
    });
    expect((await store.list()).length).toBe(1);
    expect(existsSync(memoryDirFor(rootA))).toBe(true);
    expect(sqlite.closes).toHaveLength(0);
    manager.dispose();
  });
});
