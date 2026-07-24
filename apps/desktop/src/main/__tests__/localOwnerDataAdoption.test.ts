/**
 * localOwnerDataAdoption.test — local 模式数据认领核心流程单测。
 *
 * 全部走内存 fs 假体(LocalAdoptionFsDeps 注入),不碰真实磁盘;electron 依赖经
 * vitest alias 落到 electron-stub(本文件只测纯 DI 入口 runLocalOwnerDataAdoption,
 * 不触发默认 electron 实现)。
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { LOCAL_DATA_OWNER_ID, dataOwnerStorageKey } from '../appSessionState';
import {
  LOCAL_OWNER_ADOPTION_MARKER_FILENAME,
  runLocalOwnerDataAdoption,
  __testing,
  type LocalAdoptionDecision,
  type LocalAdoptionFsDeps,
  type LocalAdoptionPhase,
  type LocalOwnerAdoptionDeps,
} from '../localOwnerDataAdoption';

const USER_DATA = path.join(path.sep, 'base', 'Cindy');
const PREFIX = 'cindy';
const USER_ID = 'user-123';
const USER_KEY = dataOwnerStorageKey(USER_ID);
const LOCAL_KEY = dataOwnerStorageKey(LOCAL_DATA_OWNER_ID);
const LOCAL_DB = path.join(USER_DATA, `${PREFIX}-${LOCAL_DATA_OWNER_ID}.db`);
const ACCOUNT_DB = path.join(USER_DATA, `${PREFIX}-${USER_ID}.db`);
const MARKER = path.join(USER_DATA, LOCAL_OWNER_ADOPTION_MARKER_FILENAME);
const LOCAL_OWNER_DIR = path.join(USER_DATA, 'owners', LOCAL_KEY);
const ACCOUNT_OWNER_DIR = path.join(USER_DATA, 'owners', USER_KEY);

type ErrnoLike = Error & { code?: string };

function errnoError(code: string, p: string): ErrnoLike {
  const err = new Error(`${code}: ${p}`) as ErrnoLike;
  err.code = code;
  return err;
}

/** 内存 fs 假体:Map 存文件内容,Set 存目录;rename 支持文件与整棵目录搬移。 */
function createMemFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (p: string) => path.normalize(p);

  const addDir = (p: string): void => {
    let cur = norm(p);
    while (true) {
      dirs.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  const addFile = (p: string, content = 'x'): void => {
    files.set(norm(p), content);
    addDir(path.dirname(p));
  };
  const exists = (p: string) => files.has(norm(p)) || dirs.has(norm(p));

  const fsDeps: LocalAdoptionFsDeps = {
    pathExists: async (p) => exists(p),
    readFile: async (p) => {
      const f = files.get(norm(p));
      if (f == null) throw errnoError('ENOENT', p);
      return f;
    },
    writeFile: async (p, content) => {
      addFile(p, content);
    },
    lstat: async (p) => {
      const np = norm(p);
      if (files.has(np)) return { isDirectory: () => false };
      if (dirs.has(np)) return { isDirectory: () => true };
      throw errnoError('ENOENT', p);
    },
    readdir: async (dir) => {
      const nd = norm(dir);
      const out = new Set<string>();
      for (const f of files.keys()) if (path.dirname(f) === nd) out.add(path.basename(f));
      for (const d of dirs) if (path.dirname(d) === nd && d !== nd) out.add(path.basename(d));
      return [...out];
    },
    mkdir: async (dir) => {
      addDir(dir);
    },
    rename: async (src, dest) => {
      const ns = norm(src);
      const nd = norm(dest);
      if (exists(dest)) throw errnoError('EEXIST', dest);
      if (files.has(ns)) {
        files.set(nd, files.get(ns)!);
        files.delete(ns);
        addDir(path.dirname(nd));
        return;
      }
      if (!dirs.has(ns)) throw errnoError('ENOENT', src);
      // 整棵目录搬移:所有后代 key 前缀替换。
      const prefix = ns + path.sep;
      for (const [f, content] of [...files]) {
        if (f.startsWith(prefix)) {
          files.delete(f);
          files.set(nd + path.sep + f.slice(prefix.length), content);
        }
      }
      for (const d of [...dirs]) {
        if (d === ns || d.startsWith(prefix)) {
          dirs.delete(d);
          dirs.add(d === ns ? nd : nd + path.sep + d.slice(prefix.length));
        }
      }
      addDir(path.dirname(nd));
    },
    rmdir: async (dir) => {
      const nd = norm(dir);
      if (!dirs.has(nd)) throw errnoError('ENOENT', dir);
      for (const f of files.keys()) if (f.startsWith(nd + path.sep)) throw errnoError('ENOTEMPTY', dir);
      for (const d of dirs) if (d !== nd && d.startsWith(nd + path.sep)) throw errnoError('ENOTEMPTY', dir);
      dirs.delete(nd);
    },
    // mem fs 的 rename 本就是「目标存在即 EEXIST」语义,与 renameNoReplace 一致。
    renameNoReplace: async (src, dest) => fsDeps.rename(src, dest),
  };

  return { files, dirs, addDir, addFile, fsDeps, exists };
}

interface HarnessOverrides {
  decision?: LocalAdoptionDecision | (() => Promise<LocalAdoptionDecision>);
  /** local 库未删除会话数(默认 3)。 */
  sessionCount?: number | (() => number);
  /** 账号库是否被使用过(默认 false = 空置)。 */
  accountUsed?: boolean;
  accountDbOpen?: boolean;
  passive?: boolean;
  concurrent?: () => boolean;
  countThrows?: boolean;
  accountProbeThrows?: boolean;
  /** now() 每次调用递增的毫秒步长(默认 0 = 固定时钟)。 */
  nowStepMs?: number;
  fsOverrides?: Partial<LocalAdoptionFsDeps>;
}

function createHarness(overrides: HarnessOverrides = {}) {
  const mem = createMemFs();
  const phases: LocalAdoptionPhase[] = [];
  const rawDecision = overrides.decision;
  const decisionFn: () => Promise<LocalAdoptionDecision> =
    typeof rawDecision === 'function' ? rawDecision : async () => rawDecision ?? 'adopt';
  const deps: LocalOwnerAdoptionDeps = {
    userDataDir: USER_DATA,
    dbFilePrefix: PREFIX,
    fs: { ...mem.fsDeps, ...overrides.fsOverrides },
    countLocalSessions: vi.fn(async () => {
      if (overrides.countThrows) throw new Error('SQLITE_CORRUPT: malformed');
      const count = overrides.sessionCount;
      return typeof count === 'function' ? count() : (count ?? 3);
    }),
    accountDbLooksUsed: vi.fn(async () => {
      if (overrides.accountProbeThrows) throw new Error('SQLITE_CORRUPT: malformed');
      return overrides.accountUsed ?? false;
    }),
    passiveSharedUserData: () => overrides.passive ?? false,
    hasConcurrentLiveInstances: overrides.concurrent ?? (() => false),
    closeLocalDbIfOpen: vi.fn(),
    accountDbCurrentlyOpen: () => overrides.accountDbOpen ?? false,
    now: (() => {
      let tick = 0;
      const base = new Date('2026-07-24T00:00:00.000Z').getTime();
      return () => new Date(base + (overrides.nowStepMs ?? 0) * tick++);
    })(),
    log: { info: vi.fn(), warn: vi.fn() },
    ui: {
      publish: (phase) => {
        phases.push(phase);
      },
      waitForDecision: decisionFn,
    },
  };
  return { mem, deps, phases };
}

describe('runLocalOwnerDataAdoption 前置探测(静默跳过,绝不弹窗)', () => {
  it('userId 为 local-v1 自身时跳过(防御 local 模式 ensureReady 误触发)', async () => {
    const { deps, phases } = createHarness();
    const result = await runLocalOwnerDataAdoption(LOCAL_DATA_OWNER_ID, deps);
    expect(result).toEqual({ status: 'skipped-local-owner' });
    expect(phases).toEqual([]);
  });

  it('local 库不存在时返回 no-local-db,不写 marker', async () => {
    const { mem, deps, phases } = createHarness();
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'no-local-db' });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('local 库存在但 0 条会话时返回 no-local-sessions,不弹窗、不写 marker(之后产生会话仍可认领)', async () => {
    const { mem, deps, phases } = createHarness({ sessionCount: 0 });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'no-local-sessions' });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('账号库已有会话(真实使用过)时返回 account-db-exists(不做行级合并,local 数据原地保留)', async () => {
    const { mem, deps, phases } = createHarness({ accountUsed: true });
    mem.addFile(LOCAL_DB);
    mem.addFile(ACCOUNT_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'account-db-exists' });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(LOCAL_DB))).toBe(true);
  });

  it('账号库正被本进程打开(同账号 ensure-ready 重入)时跳过,不动文件', async () => {
    const { mem, deps, phases } = createHarness({ accountDbOpen: true });
    mem.addFile(LOCAL_DB);
    mem.addFile(ACCOUNT_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'account-db-in-use' });
    expect(phases).toEqual([]);
  });

  it('账号库不可读时返回 account-db-unreadable,不弹窗、不动文件', async () => {
    const { mem, deps, phases } = createHarness({ accountProbeThrows: true });
    mem.addFile(LOCAL_DB);
    mem.addFile(ACCOUNT_DB, 'corrupt');
    mem.addFile(MARKER, JSON.stringify({ version: 1, pendingOwnerKeys: [USER_KEY] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('account-db-unreadable');
    expect(phases).toEqual([]);
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('corrupt');
  });

  it('账号库 wal 残留(被 worker/其它进程持有)时推迟', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(ACCOUNT_DB);
    mem.addFile(`${ACCOUNT_DB}-wal`);
    mem.addFile(MARKER, JSON.stringify({ version: 1, pendingOwnerKeys: [USER_KEY] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'account-db-busy' });
    expect(phases).toEqual([]);
  });

  it('local 库不可读(count 抛错)时返回 local-db-unreadable,不弹窗', async () => {
    const { mem, deps, phases } = createHarness({ countThrows: true });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('local-db-unreadable');
    expect(phases).toEqual([]);
  });
});

describe('runLocalOwnerDataAdoption marker 终态', () => {
  it('已认领过(claimedOwnerKey 存在)时直接返回,不再探测', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, claimedOwnerKey: 'someone-else' }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'already-claimed' });
    expect(phases).toEqual([]);
  });

  it('本账号拒绝过时返回 declined-before,不再询问', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, declinedOwnerKeys: [USER_KEY] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'declined-before' });
    expect(phases).toEqual([]);
  });

  it('其它账号拒绝过不影响本账号认领', async () => {
    const { mem, deps } = createHarness({ decision: 'adopt' });
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, declinedOwnerKeys: ['other-key'] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    // 认领成功后保留历史拒绝记录。
    const marker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      claimedOwnerKey: string;
      declinedOwnerKeys: string[];
    };
    expect(marker.claimedOwnerKey).toBe(USER_KEY);
    expect(marker.declinedOwnerKeys).toEqual(['other-key']);
  });

  it('marker 损坏时按缺失处理(前置检查兜底,不 crash)', async () => {
    const { mem, deps } = createHarness({ decision: 'keep' });
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, 'not-json{{{');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('declined');
  });
});

describe('runLocalOwnerDataAdoption 独占推迟(不取消,下次登录重来)', () => {
  it('passive shared userData 实例推迟', async () => {
    const { mem, deps, phases } = createHarness({ passive: true });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'passive-shared-user-data' });
    expect(phases).toEqual([]);
  });

  it('存在并发活实例时推迟', async () => {
    const { mem, deps, phases } = createHarness({ concurrent: () => true });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'concurrent-live-instances' });
    expect(phases).toEqual([]);
  });

  it('wal/shm 残留(库仍被持有)时推迟', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(`${LOCAL_DB}-wal`);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'local-db-busy' });
    expect(phases).toEqual([]);
  });

  it('确认窗停留期间出现并发实例:中断,failed 弹窗,local 库不动', async () => {
    let concurrentNow = false;
    const { mem, deps, phases } = createHarness({
      concurrent: () => concurrentNow,
      decision: async () => {
        concurrentNow = true; // 用户点按钮时另一实例已启动
        return 'adopt';
      },
    });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'concurrent-live-instances' });
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(mem.files.has(path.normalize(LOCAL_DB))).toBe(true);
    const marker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      pendingOwnerKeys?: string[];
    };
    expect(marker.pendingOwnerKeys).toEqual([USER_KEY]);
  });

  it('确认窗停留期间账号库出现:中断,绝不覆盖', async () => {
    const { mem, deps, phases } = createHarness({
      decision: async () => {
        mem.addFile(ACCOUNT_DB, 'account-data');
        return 'adopt';
      },
    });
    mem.addFile(LOCAL_DB, 'local-data');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('failed');
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('account-data');
    expect(mem.files.get(path.normalize(LOCAL_DB))).toBe('local-data');
  });
});

describe('runLocalOwnerDataAdoption 用户裁决', () => {
  it('拒绝:记录该账号 declined,local 数据原样保留,弹窗按 done 解除', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'keep' });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'declined' });
    expect(phases).toEqual(['confirm', 'done']);
    expect(mem.files.get(path.normalize(LOCAL_DB))).toBe('local-data');
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'))).toBe(true);
    const marker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      declinedOwnerKeys: string[];
      claimedOwnerKey?: string;
    };
    expect(marker.declinedOwnerKeys).toEqual([USER_KEY]);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('并入:owners 命名空间先合并搬移,库最后改名,marker 记 claimedOwnerKey', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'adopt', sessionCount: 5 });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'), 'mem');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'dialogues', '2026-07-20', 'sess-1', 'f.txt'), 'd');
    // 目标侧已有同名文件 → 冲突跳过,双方内容都不丢。
    mem.addFile(path.join(ACCOUNT_OWNER_DIR, 'maker-memory', 'MEMORY.md'), 'account-mem');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    if (result.status === 'adopted') {
      expect(result.ownersMoved).toBeGreaterThan(0);
      expect(result.ownersConflicts).toBe(1);
    }
    expect(phases).toEqual(['confirm', 'running', 'done']);
    // 库改名到账号命名空间。
    expect(mem.files.has(path.normalize(LOCAL_DB))).toBe(false);
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('local-data');
    // owners 内容并入;冲突文件保留账号侧,local 侧原文件留在原地(不覆盖)。
    expect(
      mem.files.get(path.normalize(path.join(ACCOUNT_OWNER_DIR, 'dialogues', '2026-07-20', 'sess-1', 'f.txt'))),
    ).toBe('d');
    expect(mem.files.get(path.normalize(path.join(ACCOUNT_OWNER_DIR, 'maker-memory', 'MEMORY.md')))).toBe(
      'account-mem',
    );
    expect(mem.files.get(path.normalize(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md')))).toBe('mem');
    const marker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      claimedOwnerKey: string;
      adoptedAt: string;
    };
    expect(marker.claimedOwnerKey).toBe(USER_KEY);
    expect(marker.adoptedAt).toBe('2026-07-24T00:00:00.000Z');
  });

  it('并入时 safe-storage 的 owner 前缀凭证一并改名到账号命名空间(冲突跳过)', async () => {
    const { mem, deps } = createHarness({ decision: 'adopt' });
    const secretsDir = path.join(USER_DATA, 'safe-storage');
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(path.join(secretsDir, `owner_${LOCAL_KEY}_provider_key_x.enc`), 'secret-x');
    mem.addFile(path.join(secretsDir, `owner_${LOCAL_KEY}_custom_mcp_y.enc`), 'secret-y');
    // 账号侧已有同逻辑键 → 冲突跳过,双方都保留。
    mem.addFile(path.join(secretsDir, `owner_${USER_KEY}_custom_mcp_y.enc`), 'account-y');
    // 其它 owner 与非 .enc 文件不受影响。
    mem.addFile(path.join(secretsDir, 'owner_other_provider_key_z.enc'), 'other');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(
      mem.files.get(path.normalize(path.join(secretsDir, `owner_${USER_KEY}_provider_key_x.enc`))),
    ).toBe('secret-x');
    expect(
      mem.files.get(path.normalize(path.join(secretsDir, `owner_${USER_KEY}_custom_mcp_y.enc`))),
    ).toBe('account-y');
    expect(
      mem.files.get(path.normalize(path.join(secretsDir, `owner_${LOCAL_KEY}_custom_mcp_y.enc`))),
    ).toBe('secret-y');
    expect(
      mem.files.get(path.normalize(path.join(secretsDir, 'owner_other_provider_key_z.enc'))),
    ).toBe('other');
    expect(
      mem.files.has(path.normalize(path.join(secretsDir, `owner_${LOCAL_KEY}_provider_key_x.enc`))),
    ).toBe(false);
  });

  it('并入时 local 无 owners 目录也成立(只搬库)', async () => {
    const { mem, deps } = createHarness({ decision: 'adopt' });
    mem.addFile(LOCAL_DB, 'local-data');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('local-data');
  });

  it('账号库存在但无 pending:无论多空一律跳过,不做任何探测让位(v1 契约)', async () => {
    const { mem, deps, phases } = createHarness({ accountUsed: false });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(ACCOUNT_DB, 'existing-account-db');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'account-db-exists' });
    expect(phases).toEqual([]);
    expect(deps.accountDbLooksUsed).not.toHaveBeenCalled();
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('existing-account-db');
  });

  it('pending 重试场景:空占位账号库改名备份让位后并入(Greptile 场景)', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'adopt', accountUsed: false });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(ACCOUNT_DB, 'empty-account-db');
    mem.addFile(MARKER, JSON.stringify({ version: 1, pendingOwnerKeys: [USER_KEY] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('local-data');
    // 空库不删,时间戳备份保留(now = 2026-07-24T00:00:00Z → 20260724000000)。
    expect(mem.files.get(path.normalize(`${ACCOUNT_DB}.pre-adoption-20260724000000`))).toBe(
      'empty-account-db',
    );
  });
});

describe('runLocalOwnerDataAdoption 失败与幂等重试', () => {
  it('库改名失败:failed 弹窗、不写 marker;下次登录续跑完成剩余搬移', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'adopt' });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'), 'mem');
    const realRenameNoReplace = deps.fs.renameNoReplace;
    let failNext = true;
    deps.fs = {
      ...deps.fs,
      renameNoReplace: async (src, dest) => {
        if (failNext && path.normalize(src) === path.normalize(LOCAL_DB)) {
          throw errnoError('EPERM', src);
        }
        return realRenameNoReplace(src, dest);
      },
    };
    const first = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(first.status).toBe('failed');
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    // 失败只登记 pending(重试凭据),不写终态。
    const firstMarker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      pendingOwnerKeys?: string[];
      claimedOwnerKey?: string;
    };
    expect(firstMarker.pendingOwnerKeys).toEqual([USER_KEY]);
    expect(firstMarker.claimedOwnerKey).toBeUndefined();
    // 失败后登录照常继续,ensureReady 会创建空账号库(Greptile 指出的堵死场景)
    // ——重试凭 pending 仍能进来:占位库让位,认领续跑完成。
    mem.addFile(ACCOUNT_DB, 'auto-created-empty-db');
    failNext = false;
    const second = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(second.status).toBe('adopted');
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('local-data');
    expect(mem.files.get(path.normalize(`${ACCOUNT_DB}.pre-adoption-20260724000000`))).toBe(
      'auto-created-empty-db',
    );
    expect(mem.files.get(path.normalize(path.join(ACCOUNT_OWNER_DIR, 'maker-memory', 'MEMORY.md')))).toBe(
      'mem',
    );
  });

  it('owners 递归合并期间发现并发实例:中断为 deferred,下次登录续跑', async () => {
    let scans = 0;
    const { mem, deps, phases } = createHarness({
      decision: 'adopt',
      nowStepMs: 600, // 每次取时钟都跨过 500ms 节流窗,abortCheck 每个子项都真扫
      concurrent: () => {
        scans += 1;
        return scans >= 3; // 第 1/2 次(步骤 2 与确认后复查)无并发,合并中途出现
      },
    });
    mem.addFile(LOCAL_DB, 'local-data');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'), 'mem');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'cindy-brain', 'b.json'), 'brain');
    // 目标 owners 目录已有内容 → 走逐子项合并路径(整棵 rename 快路径没有中断窗口)。
    mem.addFile(path.join(ACCOUNT_OWNER_DIR, 'existing.txt'), 'e');
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'deferred', reason: 'concurrent-live-instances' });
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    // 库改名(提交点)未发生,local 模式数据完好;已搬部分下次续跑。
    expect(mem.files.get(path.normalize(LOCAL_DB))).toBe('local-data');
    // 推迟登记 pending(重试凭据),不写终态。
    const marker = JSON.parse(mem.files.get(path.normalize(MARKER))!) as {
      pendingOwnerKeys?: string[];
      claimedOwnerKey?: string;
    };
    expect(marker.pendingOwnerKeys).toEqual([USER_KEY]);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('拒绝记录写失败:本次拒绝仍生效,弹窗按 done 解除不卡 confirm', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'keep' });
    mem.addFile(LOCAL_DB, 'local-data');
    const realWrite = mem.fsDeps.writeFile;
    deps.fs = {
      ...deps.fs,
      writeFile: async (p, content) => {
        if (path.normalize(p) === path.normalize(MARKER)) throw errnoError('ENOSPC', p);
        return realWrite(p, content);
      },
    };
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result).toEqual({ status: 'declined' });
    expect(phases).toEqual(['confirm', 'done']);
    expect(mem.files.get(path.normalize(LOCAL_DB))).toBe('local-data');
  });

  it('库改名(提交点)已过后 marker 写失败:按成功收尾,不误报 failed', async () => {
    const { mem, deps, phases } = createHarness({ decision: 'adopt' });
    mem.addFile(LOCAL_DB, 'local-data');
    const realWrite = mem.fsDeps.writeFile;
    deps.fs = {
      ...deps.fs,
      writeFile: async (p, content) => {
        if (path.normalize(p) === path.normalize(MARKER)) throw errnoError('ENOSPC', p);
        return realWrite(p, content);
      },
    };
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(mem.files.get(path.normalize(ACCOUNT_DB))).toBe('local-data');
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('弹窗前先关闭本进程持有的 local 库(closeLocalDbIfOpen 在 count 前被调用)', async () => {
    const { mem, deps } = createHarness({ decision: 'keep' });
    mem.addFile(LOCAL_DB);
    await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(deps.closeLocalDbIfOpen).toHaveBeenCalledTimes(1);
    const closeOrder = (deps.closeLocalDbIfOpen as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const countOrder = (deps.countLocalSessions as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(countOrder);
  });
});

describe('默认 sqlite 探针(真实 better-sqlite3 临时库)', () => {
  async function withTempDb(
    setup: (db: InstanceType<typeof Database>) => void,
    run: (dbPath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-adoption-test-'));
    const dbPath = path.join(dir, 'probe.db');
    const db = new Database(dbPath);
    try {
      setup(db);
    } finally {
      db.close();
    }
    try {
      await run(dbPath);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it('countSessionsInClosedDb 只数未删除会话(触发门槛)', async () => {
    await withTempDb(
      (db) => {
        db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
        db.exec("INSERT INTO sessions VALUES ('a','active'),('b','archived'),('c','deleted')");
      },
      async (dbPath) => {
        await expect(__testing.countSessionsInClosedDb(dbPath)).resolves.toBe(2);
      },
    );
  });

  it('accountDbLooksUsedInClosedDb:软删除会话也算「使用过」,绝不让位(Greptile 场景)', async () => {
    await withTempDb(
      (db) => {
        db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
        db.exec("INSERT INTO sessions VALUES ('a','deleted')");
      },
      async (dbPath) => {
        await expect(__testing.accountDbLooksUsedInClosedDb(dbPath)).resolves.toBe(true);
      },
    );
  });

  it('accountDbLooksUsedInClosedDb:零会话但有 schedules 也算使用过;全空才空置', async () => {
    await withTempDb(
      (db) => {
        db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
        db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY)');
        db.exec("INSERT INTO schedules VALUES ('s1')");
      },
      async (dbPath) => {
        await expect(__testing.accountDbLooksUsedInClosedDb(dbPath)).resolves.toBe(true);
      },
    );
    await withTempDb(
      (db) => {
        db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
      },
      async (dbPath) => {
        // 其余用量表不存在(老 schema)= 不可能有数据,不算使用过。
        await expect(__testing.accountDbLooksUsedInClosedDb(dbPath)).resolves.toBe(false);
      },
    );
  });
});
