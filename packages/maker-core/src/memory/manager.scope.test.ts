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

  // ── 异步竞态 (review #2388 P1) ──────────────────────────────────────────

  it('getStore 异步 init 期间 owner 切换 → 抛 not-ready 且旧 store 不入池', async () => {
    let currentRoot = rootA;
    let currentScope = 'cloud:old:1';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => currentRoot,
      ownerScopeKey: () => currentScope,
      sqliteFactory: (filePath) => {
        // 模拟「初始化 await 窗口内 owner commit」: factory 在 mkdir 后、
        // store.init 前被调用, 此时切换 scope/root 等效于窗口期切换账号。
        currentRoot = rootB;
        currentScope = 'cloud:new:2';
        return sqlite.factory(filePath);
      },
      agents: {},
      logger: noopLogger,
    });

    // 旧 owner 的 getStore 必须 fail-closed, 不得把旧 root store 提交入池
    await expect(manager.getStore(WORKDIR)).rejects.toThrow(/memory:not-ready/);

    // 当前 scope 已是 new/rootB: 后续 getStore 建在新根
    const store = await manager.getStore(WORKDIR);
    expect(store).toBeDefined();
    expect(existsSync(memoryDirFor(rootB))).toBe(true);
    manager.dispose();
  });

  it('owner 切换后 resetAll 扫新根, 不删旧 owner 数据', async () => {
    let currentRoot = rootA;
    let currentScope = 'cloud:old:1';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => currentRoot,
      ownerScopeKey: () => currentScope,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    // 旧 owner 在 rootA 写入一条 memory
    const storeA = await manager.getStore(WORKDIR);
    await storeA.write({
      type: 'project', name: 'keep', title: 'A', description: 'desc', body: 'content-A',
    });
    expect(existsSync(path.join(memoryDirFor(rootA), 'project_keep.md'))).toBe(true);

    // 切换 owner → resetAll 入口 ensureOwnerScope 换根到 rootB, 只扫 rootB (空)
    currentRoot = rootB;
    currentScope = 'cloud:new:2';
    const result = await manager.resetAll();
    expect(result.removedCount).toBe(0);
    // rootA (旧 owner) 数据完好
    expect(existsSync(path.join(memoryDirFor(rootA), 'project_keep.md'))).toBe(true);
    manager.dispose();
  });

  it('owner 切换后 resetDigests 用新根, 不动旧 owner digest 文件', async () => {
    let currentRoot = rootA;
    let currentScope = 'cloud:old:1';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => currentRoot,
      ownerScopeKey: () => currentScope,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    // 旧 owner 在 rootA 写入一条 digest + 一条 curated
    const storeA = await manager.getStore(WORKDIR);
    await storeA.write({
      type: 'digest', name: 'pi-drop', title: 'D', description: 'digest', body: 'summary',
    });
    await storeA.write({
      type: 'project', name: 'keep', title: 'K', description: 'curated', body: 'content-K',
    });
    expect(existsSync(path.join(memoryDirFor(rootA), 'digest_pi-drop.md'))).toBe(true);

    // 切换 owner → resetDigests 入口换根到 rootB (空), 不扫旧根
    currentRoot = rootB;
    currentScope = 'cloud:new:2';
    const result = await manager.resetDigests();
    expect(result.removedCount).toBe(0);
    expect(existsSync(path.join(memoryDirFor(rootA), 'digest_pi-drop.md'))).toBe(true);
    expect(existsSync(path.join(memoryDirFor(rootA), 'project_keep.md'))).toBe(true);
    manager.dispose();
  });

  it('同 workdir 并发 getStore 复用池内实例, 多余 db 被关闭', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => 'cloud:abc:1',
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });

    const [s1, s2] = await Promise.all([
      manager.getStore(WORKDIR),
      manager.getStore(WORKDIR),
    ]);
    expect(s1).toBe(s2); // 池内单实例
    // 后完成的那次打开了多余 db, 发现池中已有实例后必须关闭 (不泄漏句柄)
    expect(sqlite.closes.length).toBeGreaterThan(0);
    manager.dispose();
  });

  it('store 级 mutation 前置守卫: scope 变化后 write 抛 not-ready (review Codex 5th P1)', async () => {
    let currentScope = 'cloud:old:1';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => currentScope,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    const store = await manager.getStore(WORKDIR);
    // 调用方拿到裸 store 后, owner 切换发生在 write 之前 — mutation 前置守卫拦截
    currentScope = 'cloud:new:2';
    await expect(
      store.write({
        type: 'project', name: 'x', title: 'X', description: 'd', body: 'b',
      }),
    ).rejects.toThrow(/memory:not-ready/);
    manager.dispose();
  });

  it('store 级只读守卫: scope 变化后 getIndex 抛 not-ready (review Codex 6th P1)', async () => {
    let currentScope = 'cloud:old:1';
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => currentScope,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    const store = await manager.getStore(WORKDIR);
    // session 启动路径: getStore().getIndex() 直接拼 prompt, 边界窗口不得注入旧 owner 索引
    currentScope = 'cloud:new:2';
    await expect(store.getIndex()).rejects.toThrow(/memory:not-ready/);
    await expect(store.list()).rejects.toThrow(/memory:not-ready/);
    manager.dispose();
  });

  it('rebind 到 disabled owner 后 getStore fail-closed (review Codex 5th P1)', async () => {
    let currentScope = 'cloud:enabled:1';
    let enabledForOwner = true;
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => currentScope,
      reloadEnabled: () => enabledForOwner, // desktop: 按新 owner 根读 settings
      initialEnabled: true,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    // owner A: enabled → 正常拿到 store
    const storeA = await manager.getStore(WORKDIR);
    expect(storeA).toBeDefined();
    // 切到关闭 maker memory 的 owner B: 调用方可能已持过期 enabled=true 快照,
    // getStore 必须 fail-closed, 不得打开 B 的 store
    currentScope = 'cloud:disabled:2';
    enabledForOwner = false;
    await expect(manager.getStore(WORKDIR)).rejects.toThrow(/memory:not-ready/);
    manager.dispose();
  });

  it('disabled owner 下 resetAll/resetWorkdir 仍可清空 (review Codex 10th P2)', async () => {
    let currentScope = 'cloud:disabled:2';
    let enabledForOwner = false;
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => currentScope,
      reloadEnabled: () => enabledForOwner,
      initialEnabled: false,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    // 打开 store 被拒 (disabled) — 正常工具/会话路径
    await expect(manager.getStore(WORKDIR)).rejects.toThrow(/memory:not-ready/);
    // 清理路径仍允许: 用户关闭 memory 后要能删掉已有记忆
    const viaManager = await manager.resetAll();
    expect(viaManager.removedCount).toBe(0);
    const viaWorkdir = await manager.resetWorkdir(WORKDIR);
    expect(viaWorkdir.removedCount).toBe(0);
    manager.dispose();
  });

  it('isEnabled 读取前同步 scope, 不残留旧 owner flag (review Codex 11th P1)', async () => {
    let currentScope = 'cloud:disabled:1'; // owner A: maker:false
    let enabledForOwner = false;
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => currentScope,
      reloadEnabled: () => enabledForOwner,
      initialEnabled: false,
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    // 冷启动: owner 未就绪时 isEnabled 读的是初始值 (false) — withStore 会短路
    expect(manager.isEnabled()).toBe(false);
    // owner B 就绪且 maker:true: 无需任何 getStore, isEnabled 必须刷新
    currentScope = 'cloud:enabled:2';
    enabledForOwner = true;
    expect(manager.isEnabled()).toBe(true);
    // 反向: 切回 disabled owner, 再次同步
    currentScope = 'cloud:disabled:3';
    enabledForOwner = false;
    expect(manager.isEnabled()).toBe(false);
    manager.dispose();
  });

  // Windows runner 上 SQLite 文件关闭后，Defender 仍可能短暂占用目录；这个用例
  // 覆盖真实磁盘删除与重建，采用独立的 I/O 预算，避免拖宽整个 suite 的默认超时。
  it('resetAll 清空目录并重建 store (review Greptile 16th)', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => 'cloud:abc:1',
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    const storeA = await manager.getStore(WORKDIR);
    await storeA.write({
      type: 'project', name: 'a', title: 'A', description: 'd', body: 'b',
    });
    expect(existsSync(memoryDirFor(rootA))).toBe(true);

    // resetAll: 开头关闭入口池 (避免 fs.rm EBUSY) + 并发拒绝 → 删除全部目录
    const result = await manager.resetAll();
    expect(result.removedCount).toBeGreaterThan(0);
    expect(existsSync(memoryDirFor(rootA))).toBe(false);

    // 再次 getStore: 池已清空 → 全新 store + 目录重建
    const storeB = await manager.getStore(WORKDIR);
    expect(storeB).not.toBe(storeA);
    expect(existsSync(memoryDirFor(rootA))).toBe(true);
    manager.dispose();
  }, 20_000);

  it('resetAll 后旧 store 任何操作抛 not-ready, 不碰已关 db (review Greptile 20th P1)', async () => {
    const sqlite = trackingSqlite();
    const manager = new MakerMemoryManager({
      basePath: rootA,
      resolveBasePath: () => rootA,
      ownerScopeKey: () => 'cloud:abc:1',
      sqliteFactory: sqlite.factory,
      agents: {},
      logger: noopLogger,
    });
    const store = await manager.getStore(WORKDIR);
    await store.write({
      type: 'project', name: 'a', title: 'A', description: 'd', body: 'b',
    });
    // resetAll 完整执行 → 旧 store 的 db 已被 closeAllStores 关闭
    await manager.resetAll();
    // 调用方持有的旧世代 store: 读/搜均 fail-closed 抛 not-ready,
    // 不得访问已关句柄抛裸 database is closed
    await expect(store.list()).rejects.toThrow(/memory:not-ready/);
    await expect(store.search('a')).rejects.toThrow(/memory:not-ready/);
    await expect(store.getIndex()).rejects.toThrow(/memory:not-ready/);
    manager.dispose();
  });
});
