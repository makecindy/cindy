/**
 * localOwnerDataAdoption.test — local 模式数据认领核心流程单测。
 *
 * 全部走内存 fs 假体(LocalAdoptionFsDeps 注入),不碰真实磁盘;导入本身(SQL 语义)
 * 由 localOwnerDataImport.test.ts 用真实 sqlite 覆盖,这里只注入其结果,专测流程:
 * 前置门槛、marker 状态机、提交点前后的失败语义、收尾续跑。
 * electron 依赖经 vitest alias 落到 electron-stub(本文件只测纯 DI 入口)。
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { LOCAL_DATA_OWNER_ID, dataOwnerStorageKey } from '../appSessionState';
import { ownerSecretStoragePrefix } from '../secrets/providerSecretStore';
import { ownerScopedImSecretPrefix } from '../im/ownerScopedStorage';
import {
  LOCAL_OWNER_ADOPTION_MARKER_FILENAME,
  runLocalOwnerDataAdoption,
  type LocalAdoptionDecision,
  type LocalAdoptionFsDeps,
  type LocalAdoptionPhase,
  type LocalOwnerAdoptionDeps,
} from '../localOwnerDataAdoption';
import type { LocalOwnerImportResult } from '../localDb/localOwnerDataImport';

const USER_DATA = path.join(path.sep, 'base', 'Cindy');
const PREFIX = 'cindy';
const USER_ID = 'user-123';
const USER_KEY = dataOwnerStorageKey(USER_ID);
const LOCAL_KEY = dataOwnerStorageKey(LOCAL_DATA_OWNER_ID);
const LOCAL_DB = path.join(USER_DATA, `${PREFIX}-${LOCAL_DATA_OWNER_ID}.db`);
const MARKER = path.join(USER_DATA, LOCAL_OWNER_ADOPTION_MARKER_FILENAME);
const LOCAL_OWNER_DIR = path.join(USER_DATA, 'owners', LOCAL_KEY);
const ACCOUNT_OWNER_DIR = path.join(USER_DATA, 'owners', USER_KEY);
const SECRETS_DIR = path.join(USER_DATA, 'safe-storage');

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
    for (;;) {
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
      for (const f of files.keys()) {
        if (f.startsWith(nd + path.sep)) throw errnoError('ENOTEMPTY', dir);
      }
      for (const d of dirs) {
        if (d !== nd && d.startsWith(nd + path.sep)) throw errnoError('ENOTEMPTY', dir);
      }
      dirs.delete(nd);
    },
    replaceFile: async (src, dest) => {
      files.delete(norm(dest));
      await fsDeps.rename(src, dest);
    },
  };

  return { files, dirs, addDir, addFile, fsDeps, exists };
}

const emptyImport: LocalOwnerImportResult = {
  inserted: 0,
  perTable: {},
  missingInSource: [],
  droppedRows: {},
  unverifiedTables: [],
  unimportableTables: [],
  conflictedSessions: 0,
  pausedSchedules: 0,
};

interface HarnessOverrides {
  decision?: LocalAdoptionDecision | (() => Promise<LocalAdoptionDecision>);
  /** local 库未删除会话数(默认 3)。 */
  sessionCount?: number;
  /** 源批次指纹(默认固定值;改它模拟「回到 local 模式又动过数据」)。 */
  fingerprint?: string;
  countThrows?: boolean;
  passive?: boolean;
  concurrent?: () => boolean;
  /** 导入结果;要模拟失败用 importThrows。 */
  importResult?: Partial<LocalOwnerImportResult>;
  importThrows?: boolean;
  ownerStillCurrent?: () => boolean;
  fsOverrides?: Partial<LocalAdoptionFsDeps>;
}

function createHarness(overrides: HarnessOverrides = {}) {
  const mem = createMemFs();
  const phases: LocalAdoptionPhase[] = [];
  const rawDecision = overrides.decision;
  const decisionFn: () => Promise<LocalAdoptionDecision> =
    typeof rawDecision === 'function' ? rawDecision : async () => rawDecision ?? 'adopt';
  const importLocalData = vi.fn(async (_localDbPath: string, _options: { resuming: boolean }) => {
    if (overrides.importThrows) throw new Error('SQLITE_BUSY: database is locked');
    return { ...emptyImport, inserted: 5, ...overrides.importResult };
  });
  const deps: LocalOwnerAdoptionDeps = {
    userDataDir: USER_DATA,
    dbFilePrefix: PREFIX,
    fs: { ...mem.fsDeps, ...overrides.fsOverrides },
    probeLocalDb: vi.fn(async () => {
      if (overrides.countThrows) throw new Error('SQLITE_CORRUPT: malformed');
      return {
        sessionCount: overrides.sessionCount ?? 3,
        fingerprint: overrides.fingerprint ?? 'fp-original',
      };
    }),
    importLocalData,
    passiveSharedUserData: () => overrides.passive ?? false,
    hasConcurrentLiveInstances: overrides.concurrent ?? (() => false),
    closeLocalDbIfOpen: vi.fn(),
    isOwnerStillCurrent: overrides.ownerStillCurrent ?? (() => true),
    now: () => new Date('2026-07-27T00:00:00.000Z'),
    log: { info: vi.fn(), warn: vi.fn() },
    ui: {
      publish: (phase) => {
        phases.push(phase);
      },
      waitForDecision: decisionFn,
    },
  };
  return { mem, deps, phases, importLocalData };
}

const readMarker = (mem: ReturnType<typeof createMemFs>): Record<string, unknown> =>
  JSON.parse(mem.files.get(path.normalize(MARKER)) ?? '{}') as Record<string, unknown>;

/** 归档出来的主库文件名(排除随之归档的 -wal / -shm sidecar)。 */
const archivedDbNames = (mem: ReturnType<typeof createMemFs>): string[] =>
  [...mem.files.keys()].filter(
    (f) =>
      f.startsWith(`${path.normalize(LOCAL_DB)}.adopted-`) &&
      !f.endsWith('-wal') &&
      !f.endsWith('-shm'),
  );

describe('runLocalOwnerDataAdoption 前置探测(静默跳过,绝不弹窗)', () => {
  it('userId 为 local-v1 自身时跳过(防御 local 模式 ensureReady 误触发)', async () => {
    const { deps, phases } = createHarness();
    expect(await runLocalOwnerDataAdoption(LOCAL_DATA_OWNER_ID, deps)).toEqual({
      status: 'skipped-local-owner',
    });
    expect(phases).toEqual([]);
  });

  it('local 库不存在时返回 no-local-db,不写 marker', async () => {
    const { mem, deps, phases } = createHarness();
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'no-local-db' });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('local 库 0 条会话时返回 no-local-sessions,不写 marker(之后产生会话仍可认领)', async () => {
    const { mem, deps, phases } = createHarness({ sessionCount: 0 });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'no-local-sessions' });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('local 库不可读时返回 local-db-unreadable,不弹窗、不导入', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({ countThrows: true });
    mem.addFile(LOCAL_DB);
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('local-db-unreadable');
    expect(phases).toEqual([]);
    expect(importLocalData).not.toHaveBeenCalled();
  });

  it('local 库 wal 残留(仍被别的进程持有)时推迟,不写 marker', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(`${LOCAL_DB}-wal`);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'deferred',
      reason: 'local-db-busy',
    });
    expect(phases).toEqual([]);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('passive 共享 userData 实例只推迟,绝不动数据', async () => {
    const { mem, deps, importLocalData } = createHarness({ passive: true });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'deferred',
      reason: 'passive-shared-user-data',
    });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('存在并发活实例时只推迟(不写 marker,下次登录前提同样成立)', async () => {
    const { mem, deps, importLocalData } = createHarness({ concurrent: () => true });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'deferred',
      reason: 'concurrent-live-instances',
    });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
  });

  it('账号库已有数据不再是障碍:认领照常进行(合并语义)', async () => {
    const { mem, deps, importLocalData } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(USER_DATA, `${PREFIX}-${USER_ID}.db`));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(importLocalData).toHaveBeenCalledWith(path.normalize(LOCAL_DB), { resuming: false });
  });
});

describe('runLocalOwnerDataAdoption marker 终态', () => {
  it('上次已认领过、但用户又在 local 模式攒了新对话时重新询问(claimed 不是永久终态)', async () => {
    const { mem, deps, phases } = createHarness();
    // 上次认领把当时那个 local 库归档了;这个 LOCAL_DB 是之后新建的。
    mem.addFile(LOCAL_DB);
    mem.addFile(
      MARKER,
      JSON.stringify({ version: 1, claimedOwnerKey: USER_KEY, adoptedAt: '2026-07-01T00:00:00.000Z' }),
    );

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('adopted');
    expect(phases).toEqual(['confirm', 'running', 'done']);
  });

  it('别的账号导入完但收尾没走完时静默让路,不问、不导入、不动文件', async () => {
    const { mem, deps, phases, importLocalData } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`), 'k');
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: 'other-account-key' }));

    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'imported-by-other-account',
    });
    expect(phases).toEqual([]);
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.exists(LOCAL_DB)).toBe(true);
    // 它的凭证也不能被本账号顺走。
    expect(
      mem.exists(path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`)),
    ).toBe(true);
  });

  it('本账号此前拒绝过时不再询问', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, declinedOwnerKeys: [USER_KEY] }));
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'declined-before' });
    expect(phases).toEqual([]);
  });

  it('别的账号拒绝过不影响本账号(数据仍可被认领),且保留它的记录', async () => {
    const { mem, deps } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, declinedOwnerKeys: ['other-key'] }));
    const result = await runLocalOwnerDataAdoption(USER_ID, deps);
    expect(result.status).toBe('adopted');
    expect(readMarker(mem).declinedOwnerKeys).toEqual(['other-key']);
  });

  it('marker 损坏时当作缺失(导入幂等,最坏是再问一次)', async () => {
    const { mem, deps } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, '{ not json');
    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');
  });
});

describe('runLocalOwnerDataAdoption 用户拒绝', () => {
  it('选「保留在本机模式」时记录该账号、不导入、不动任何文件', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({ decision: 'keep' });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'));

    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'declined' });

    expect(phases).toEqual(['confirm', 'done']);
    expect(importLocalData).not.toHaveBeenCalled();
    expect(readMarker(mem)).toEqual({ version: 1, declinedOwnerKeys: [USER_KEY] });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
  });

  it('拒绝记录写失败时仍要解除弹窗(否则 phase 卡在 confirm)', async () => {
    const { mem, deps, phases } = createHarness({
      decision: 'keep',
      fsOverrides: {
        writeFile: async () => {
          throw errnoError('ENOSPC', MARKER);
        },
      },
    });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'declined' });
    expect(phases).toEqual(['confirm', 'done']);
  });
});

describe('runLocalOwnerDataAdoption 并入全流程', () => {
  it('导入 → 归档 local 库 → 搬 owners(dialogues 除外)→ 搬凭证 → 写终态', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({
      importResult: { inserted: 7, perTable: { sessions: 3, messages: 4 } },
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'maker-memory', 'MEMORY.md'), 'mem');
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'dialogues', '2026-07-27', 's1', 'note.txt'), 'dlg');
    mem.addFile(
      path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}anthropic.enc`),
      'k1',
    );
    mem.addFile(
      path.join(SECRETS_DIR, `${ownerScopedImSecretPrefix(LOCAL_DATA_OWNER_ID)}feishu.enc`),
      'k2',
    );

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result).toEqual({ status: 'adopted', imported: 7, resumed: false });
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(importLocalData).toHaveBeenCalledWith(path.normalize(LOCAL_DB), { resuming: false });

    // local 库归档保留(不删),原名消失 → 回到 local 模式是全新空间。
    expect(mem.exists(LOCAL_DB)).toBe(false);
    expect(archivedDbNames(mem)).toHaveLength(1);

    // owners 下非 dialogues 项搬到账号命名空间。
    expect(mem.files.get(path.normalize(path.join(ACCOUNT_OWNER_DIR, 'learn', 'runs.json')))).toBe(
      'learn',
    );
    expect(
      mem.files.get(path.normalize(path.join(ACCOUNT_OWNER_DIR, 'maker-memory', 'MEMORY.md'))),
    ).toBe('mem');

    // dialogues 故意留在原地:working_dir 改写与内容搬运由 sweep 逐行负责。
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'dialogues', '2026-07-27', 's1', 'note.txt'))).toBe(
      true,
    );
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'dialogues'))).toBe(false);

    // 凭证按 owner 前缀改名。
    expect(
      mem.files.get(
        path.normalize(path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(USER_ID)}anthropic.enc`)),
      ),
    ).toBe('k1');
    expect(
      mem.files.get(
        path.normalize(path.join(SECRETS_DIR, `${ownerScopedImSecretPrefix(USER_ID)}feishu.enc`)),
      ),
    ).toBe('k2');

    expect(readMarker(mem)).toEqual({
      version: 1,
      claimedOwnerKey: USER_KEY,
      adoptedAt: '2026-07-27T00:00:00.000Z',
    });
  });

  it('确认窗停留期间 owner 变了(登出/切号)时中止,绝不并进失效账号', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({
      ownerStillCurrent: () => false,
    });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'stale-owner' });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.exists(LOCAL_DB)).toBe(true);
    // 复查在 publish('running') 之前:中止路径不该让弹窗闪一下「正在并入…」。
    expect(phases).toEqual(['confirm', 'done']);
  });

  it('确认窗停留期间出现并发实例时推迟,不导入不动文件', async () => {
    let calls = 0;
    const { mem, deps, importLocalData } = createHarness({
      // 第一次(前置)无并发,确认后复查时出现。
      concurrent: () => calls++ > 0,
    });
    mem.addFile(LOCAL_DB);
    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'deferred',
      reason: 'concurrent-live-instances',
    });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(mem.exists(LOCAL_DB)).toBe(true);
  });
});

describe('runLocalOwnerDataAdoption 提交点语义', () => {
  it('导入失败(提交点未过)时不写任何 marker,local 数据分毫未动', async () => {
    const { mem, deps, phases } = createHarness({ importThrows: true });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('failed');
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
    expect(mem.exists(LOCAL_DB)).toBe(true);
    // 收尾一步都不能提前发生(#314 codex review:文件不得先于提交点搬走)。
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
  });

  it('收尾失败时 marker 停在 importedOwnerKey(会话已可见,下次登录续跑)', async () => {
    const { mem, deps, phases } = createHarness({
      fsOverrides: {
        // 归档与 owners 搬移都走 rename;让它一律失败模拟只读盘。
        rename: async (_src, dest) => {
          throw errnoError('EPERM', dest);
        },
      },
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('adopted');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    const marker = readMarker(mem);
    expect(marker.importedOwnerKey).toBe(USER_KEY);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('凭 importedOwnerKey 续跑时静默收尾,不再弹窗询问', async () => {
    const { mem, deps, phases, importLocalData } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result).toMatchObject({ status: 'adopted', resumed: true });
    // 没有 confirm:用户已经批准过一次,导入也已提交。
    expect(phases).toEqual(['running', 'done']);
    // 续跑仍会重跑导入(幂等),把可能漏掉的行补上。
    expect(importLocalData).toHaveBeenCalledTimes(1);
    expect(archivedDbNames(mem)).toHaveLength(1);
    expect(readMarker(mem).claimedOwnerKey).toBe(USER_KEY);
  });

  it('续跑时给导入端带上 resuming(账号侧字段已被 sweep 改写,不能再按内容比冲突)', async () => {
    const { mem, deps, importLocalData } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(importLocalData).toHaveBeenCalledWith(path.normalize(LOCAL_DB), { resuming: true });
  });

  it('importedOwnerKey 落不下来时一步收尾都不做(所有权凭据缺失,不能动共享文件)', async () => {
    const { mem, deps, phases } = createHarness({
      fsOverrides: {
        writeFile: async () => {
          throw errnoError('ENOSPC', MARKER);
        },
      },
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');
    mem.addFile(
      path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`),
      'k',
    );

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('adopted');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    // 共享面(owner 文件、凭证)一个都不能动:搬走才会造成所有权劈裂。
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
    expect(
      mem.exists(path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`)),
    ).toBe(true);
    // 但 local 库要归档:没有 marker 记所有权时,把源移出活路径是唯一能阻止
    // 另一个账号重复认领同一批数据的手段(Greptile review)。
    expect(mem.exists(LOCAL_DB)).toBe(false);
    expect(archivedDbNames(mem)).toHaveLength(1);
  });

  it('marker 写失败且实例非独占时连归档都不做(passive/并发下动共享文件是禁区)', async () => {
    const { mem, deps } = createHarness({
      concurrent: () => false,
      passive: false,
      fsOverrides: {
        writeFile: async () => {
          throw errnoError('ENOSPC', MARKER);
        },
      },
    });
    mem.addFile(LOCAL_DB);
    // 导入提交后、归档前冒出并发实例。
    let calls = 0;
    deps.hasConcurrentLiveInstances = () => calls++ >= 2;

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
  });

  it('续跑时源库指纹没变 → 静默续跑,不再弹窗', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({ fingerprint: 'fp-original' });
    mem.addFile(LOCAL_DB);
    mem.addFile(
      MARKER,
      JSON.stringify({
        version: 1,
        importedOwnerKey: USER_KEY,
        importedSourceFingerprint: 'fp-original',
      }),
    );

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(phases).toEqual(['running', 'done']);
    expect(importLocalData).toHaveBeenCalledWith(path.normalize(LOCAL_DB), { resuming: true });
  });

  it('续跑时源库指纹变了(用户回 local 模式又加了东西)→ 重新弹窗确认归属', async () => {
    const { mem, deps, phases, importLocalData } = createHarness({ fingerprint: 'fp-changed' });
    mem.addFile(LOCAL_DB);
    mem.addFile(
      MARKER,
      JSON.stringify({
        version: 1,
        importedOwnerKey: USER_KEY,
        importedSourceFingerprint: 'fp-original',
      }),
    );

    await runLocalOwnerDataAdoption(USER_ID, deps);

    // 新增的那批没经过归属确认,不能借 importedOwnerKey 静默并进来。
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(importLocalData).toHaveBeenCalledWith(path.normalize(LOCAL_DB), { resuming: false });
  });

  it('指纹变化后用户选「保留在本机模式」时照常记录拒绝,不导入', async () => {
    const { mem, deps, importLocalData } = createHarness({
      fingerprint: 'fp-changed',
      decision: 'keep',
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(
      MARKER,
      JSON.stringify({
        version: 1,
        importedOwnerKey: USER_KEY,
        importedSourceFingerprint: 'fp-original',
      }),
    );

    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({ status: 'declined' });
    expect(importLocalData).not.toHaveBeenCalled();
  });

  it('首次导入把源批次指纹写进 marker(后续续跑的比对基准)', async () => {
    const { mem, deps } = createHarness({
      fingerprint: 'fp-abc',
      // 让收尾停在 importedOwnerKey,好观察指纹字段。
      importResult: { inserted: 2, droppedRows: { messages: 1 } },
    });
    mem.addFile(LOCAL_DB);

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(readMarker(mem).importedSourceFingerprint).toBe('fp-abc');
  });

  it('续跑时本账号的旧拒绝记录不再拦路(导入已提交,认领事实成立)', async () => {
    const { mem, deps } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(
      MARKER,
      JSON.stringify({ version: 1, importedOwnerKey: USER_KEY, declinedOwnerKeys: [USER_KEY] }),
    );
    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');
  });

  it('passive 实例不得在 no-DB 续跑路径上搬 owner 文件与凭证', async () => {
    // 这条早返回分支在外层 passive 门之前,收尾必须自己再守一次(codex review)。
    const { mem, deps } = createHarness({ passive: true });
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');
    mem.addFile(
      path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`),
      'k',
    );

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
    expect(
      mem.exists(path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}k.enc`)),
    ).toBe(true);
    // 收尾没做完 → 不落终态。
    expect(readMarker(mem).claimedOwnerKey).toBeUndefined();
  });

  it('凭证撞名时在收尾开始前就放弃:库不归档、owner 文件不搬(预检)', async () => {
    const { mem, deps } = createHarness();
    const localSecret = path.join(
      SECRETS_DIR,
      `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}provider_key_p1_claude.enc`,
    );
    mem.addFile(LOCAL_DB);
    mem.addFile(localSecret, 'local-key');
    mem.addFile(
      path.join(SECRETS_DIR, `${ownerSecretStoragePrefix(USER_ID)}provider_key_p1_claude.enc`),
      'account-key',
    );
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');

    // 撞名在收尾**开始前**就被发现 → 库还在活路径、owner 文件没搬、凭证没动,
    // local 模式是完整兜底(而不是「库已归档但说着兜底」)。
    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
    expect(mem.files.get(path.normalize(localSecret))).toBe('local-key');
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('cleanup skipped entirely so local mode stays a complete fallback'),
      1,
    );
  });

  it('续跑时 local 库已不在(归档其实成功过)→ 补写终态,不再每次登录白跑', async () => {
    const { mem, deps, importLocalData } = createHarness();
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result).toEqual({ status: 'adopted', imported: 0, resumed: true });
    expect(importLocalData).not.toHaveBeenCalled();
    expect(readMarker(mem).claimedOwnerKey).toBe(USER_KEY);
  });

  it('收尾开始前出现并发实例时不动任何文件,停在 importedOwnerKey 等下次续跑', async () => {
    let calls = 0;
    const { mem, deps } = createHarness({
      // 前置与提交前复查放行(第 1、2 次),收尾进场那次(第 3 次)才出现实例。
      concurrent: () => calls++ >= 2,
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('adopted');
    // 另一个 local 实例可能正开着这个库、读着这些配置,一个字节都不能动。
    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
    const marker = readMarker(mem);
    expect(marker.importedOwnerKey).toBe(USER_KEY);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('续跑路径也走一次 open+close checkpoint(否则残留 sidecar 永久卡住续跑)', async () => {
    const { mem, deps } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(deps.probeLocalDb).toHaveBeenCalledWith(path.normalize(LOCAL_DB));
  });

  it('续跑时 local 库 0 条会话不再当门槛(导入早已提交,收尾照做)', async () => {
    const { mem, deps } = createHarness({ sessionCount: 0 });
    mem.addFile(LOCAL_DB);
    mem.addFile(MARKER, JSON.stringify({ version: 1, importedOwnerKey: USER_KEY }));

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');
    expect(archivedDbNames(mem)).toHaveLength(1);
  });

  it('归档时把残留的 -wal/-shm 一起搬走(不给新建 local 库留失配 WAL)', async () => {
    const { mem, deps } = createHarness({
      // 前置的 sidecar 门槛靠 checkpoint 清掉;这里模拟 checkpoint 后又冒出来的残留。
      fsOverrides: {
        pathExists: async (p) => {
          const np = path.normalize(p);
          if (np === path.normalize(`${LOCAL_DB}-wal`)) return sidecarVisible;
          return mem.files.has(np) || mem.dirs.has(np);
        },
      },
    });
    let sidecarVisible = false;
    mem.addFile(LOCAL_DB);
    mem.addFile(`${LOCAL_DB}-wal`, 'wal-bytes');
    // 前置检查时不可见(已 checkpoint),收尾归档时可见。
    const originalImport = deps.importLocalData;
    deps.importLocalData = (async (dbPath, options) => {
      sidecarVisible = true;
      return originalImport(dbPath, options);
    }) as typeof deps.importLocalData;

    await runLocalOwnerDataAdoption(USER_ID, deps);

    const archived = archivedDbNames(mem);
    expect(archived).toHaveLength(1);
    expect([...mem.files.keys()].some((f) => f.endsWith('-wal') && f.includes('.adopted-'))).toBe(
      true,
    );
    expect(mem.exists(`${LOCAL_DB}-wal`)).toBe(false);
  });

  it('db 运行时不支持导入 tx(inline worker 回滚口)时推迟,不写 marker、不报失败', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    deps.importLocalData = async () => {
      throw Object.assign(new Error('unknown tx: localOwner.importData'), { code: 'UNKNOWN_TX' });
    };

    expect(await runLocalOwnerDataAdoption(USER_ID, deps)).toEqual({
      status: 'deferred',
      reason: 'import-unsupported-runtime',
    });
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
    expect(mem.exists(LOCAL_DB)).toBe(true);
  });

  it('同 id 会话冲突时导入整体中止:零写入、不写 marker、local 数据分毫未动', async () => {
    const { mem, deps, phases } = createHarness();
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');
    deps.importLocalData = async () => {
      throw Object.assign(new Error('2 local session(s) share an id'), {
        code: 'LOCAL_OWNER_SESSION_ID_CONFLICT',
        conflictedSessions: 2,
      });
    };

    const result = await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(result.status).toBe('failed');
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('share an id with a different account session'),
      2,
    );
    // 零写入:marker、库、owner 文件全都没动。
    expect(mem.files.has(path.normalize(MARKER))).toBe(false);
    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
  });

  it('账号侧已有同名凭证时不覆盖,并按收尾未完成处理(配置可能缺凭证)', async () => {
    const { mem, deps } = createHarness();
    const localSecret = path.join(
      SECRETS_DIR,
      `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}provider_key_p1_claude.enc`,
    );
    const accountSecret = path.join(
      SECRETS_DIR,
      `${ownerSecretStoragePrefix(USER_ID)}provider_key_p1_claude.enc`,
    );
    mem.addFile(LOCAL_DB);
    mem.addFile(localSecret, 'local-key');
    mem.addFile(accountSecret, 'account-key');

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');

    expect(mem.files.get(path.normalize(accountSecret))).toBe('account-key');
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('already exist under the account namespace'),
      1,
    );
    // 收尾未完成 → 停在 importedOwnerKey,下次登录续跑。
    const marker = readMarker(mem);
    expect(marker.importedOwnerKey).toBe(USER_KEY);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('导入的定时任务被暂停时记录下来(用户只裁决了对话归属)', async () => {
    const { mem, deps } = createHarness({ importResult: { inserted: 6, pausedSchedules: 3 } });
    mem.addFile(LOCAL_DB);

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(deps.log.info).toHaveBeenCalledWith(
      expect.stringContaining('schedules were paused'),
      3,
    );
  });

  it('导入丢了行时如实 warn 出丢了哪些表、多少行', async () => {
    const { mem, deps } = createHarness({
      importResult: { inserted: 2, droppedRows: { messages: 3, sessions: 1 } },
    });
    mem.addFile(LOCAL_DB);

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');

    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be imported'),
      4,
      'messages=3 sessions=1',
    );
  });

  it('丢行时整体跳过收尾:库、owner 文件、凭证全部留在原地(完整兜底)', async () => {
    const { mem, deps } = createHarness({
      importResult: { inserted: 2, droppedRows: { messages: 3 } },
    });
    const localSecret = path.join(
      SECRETS_DIR,
      `${ownerSecretStoragePrefix(LOCAL_DATA_OWNER_ID)}anthropic.enc`,
    );
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');
    mem.addFile(localSecret, 'k');

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');

    // 只留个空壳库而配置/凭证已搬走 = 兜底是句空话,三者必须都在。
    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
    expect(mem.exists(path.join(ACCOUNT_OWNER_DIR, 'learn'))).toBe(false);
    expect(mem.files.get(path.normalize(localSecret))).toBe('k');
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('cleanup skipped entirely'),
    );
    // 不写 claimed:否则下次登录会拿同一个 local 库再弹一次窗。停在 imported
    // 让后续登录静默重跑,schema 对上了就自然收尾。
    const marker = readMarker(mem);
    expect(marker.importedOwnerKey).toBe(USER_KEY);
    expect(marker.claimedOwnerKey).toBeUndefined();
  });

  it('整表没导入时同样整体跳过收尾', async () => {
    const { mem, deps } = createHarness({
      importResult: { inserted: 1, unimportableTables: ['custom_providers'] },
    });
    mem.addFile(LOCAL_DB);
    mem.addFile(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'), 'learn');

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(mem.exists(LOCAL_DB)).toBe(true);
    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(path.join(LOCAL_OWNER_DIR, 'learn', 'runs.json'))).toBe(true);
  });

  it('unverifiedTables 非空时也保守保留兜底(无主键可核验 = schema 不对劲)', async () => {
    const { mem, deps } = createHarness({
      importResult: { inserted: 3, unverifiedTables: ['recent_workdirs'] },
    });
    mem.addFile(LOCAL_DB);

    await runLocalOwnerDataAdoption(USER_ID, deps);

    expect(archivedDbNames(mem)).toHaveLength(0);
    expect(mem.exists(LOCAL_DB)).toBe(true);
  });

  it('整表没导入 / 无法核验时同样 warn(与丢行同级的「没并过来」信号)', async () => {
    const { mem, deps } = createHarness({
      importResult: {
        inserted: 1,
        unimportableTables: ['custom_providers'],
        unverifiedTables: ['recent_workdirs'],
      },
    });
    mem.addFile(LOCAL_DB);

    expect((await runLocalOwnerDataAdoption(USER_ID, deps)).status).toBe('adopted');

    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no compatible table'),
      'custom_providers',
    );
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not verify row completeness'),
      'recent_workdirs',
    );
  });
});
