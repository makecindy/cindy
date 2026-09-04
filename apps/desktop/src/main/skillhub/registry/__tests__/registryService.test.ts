/**
 * registryService.test.ts — CRUD + 并发 + 损坏文件容忍 单测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── mock electron ─────────────────────────────────────────────────────────────

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir;
      return userDataDir;
    },
  },
}));

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  userDataDir = path.join(os.tmpdir(), `registry-svc-test-${randomUUID()}`);
});

afterEach(() => {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
});

let addInstall: typeof import('../registryService.js').addInstall;
let updateInstall: typeof import('../registryService.js').updateInstall;
let removeInstall: typeof import('../registryService.js').removeInstall;
let readManifest: typeof import('../registryService.js').readManifest;
let getInstall: typeof import('../registryService.js').getInstall;
let listAllInstalls: typeof import('../registryService.js').listAllInstalls;
let updateCatalogScopeForSkill: typeof import('../registryService.js').updateCatalogScopeForSkill;

beforeEach(async () => {
  vi.resetModules();
  const svc = await import('../registryService.js');
  addInstall = svc.addInstall;
  updateInstall = svc.updateInstall;
  removeInstall = svc.removeInstall;
  readManifest = svc.readManifest;
  getInstall = svc.getInstall;
  listAllInstalls = svc.listAllInstalls;
  updateCatalogScopeForSkill = svc.updateCatalogScopeForSkill;
});

import type { StoredInstall, StoredManifest } from '../types.js';

function makeEntry(overrides?: Partial<StoredInstall>): StoredInstall {
  return {
    version: '3',
    authorId: '',
    folderHash: 'deadbeef',
    installedAt: 1714000000,
    updatedAt: 1714000000,
    ...overrides,
  };
}

const globalPath = path.join(os.homedir(), '.claude', 'skills', 'my-skill');

function manifestPath(skillName: string): string {
  return path.join(userDataDir, 'skillhub', 'manifests', `${skillName}.json`);
}

function backupManifestPath(skillName: string): string {
  return path.join(userDataDir, 'skillhub', 'manifests-backup', `${skillName}.json`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function createSkillDir(skillName: string): string {
  const dir = path.join(userDataDir, 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# test\n', 'utf-8');
  return dir;
}

function expectManifest(manifest: StoredManifest | null): StoredManifest {
  if (!manifest) throw new Error('manifest 应该存在');
  return manifest;
}

function expectInstall(entry: StoredInstall | null | undefined): StoredInstall {
  if (!entry) throw new Error('install entry 应该存在');
  return entry;
}

describe('addInstall', () => {
  it('新建文件 + 读回一致', async () => {
    const entry = makeEntry();
    await addInstall('my-skill', globalPath, entry);
    const manifest = expectManifest(await readManifest('my-skill'));
    expect(manifest.skillName).toBe('my-skill');
    expect(manifest.schemaVersion).toBe(1);
    const normalizedPath = path.normalize(globalPath);
    expect(manifest.installs[normalizedPath]).toEqual({ ...entry, catalogScopeMigrated: true });
  });

  it('同 (name, path) 重复 addInstall → 覆盖（不报错）', async () => {
    await addInstall('my-skill', globalPath, makeEntry({ version: '1' }));
    await addInstall('my-skill', globalPath, makeEntry({ version: '2' }));
    const manifest = expectManifest(await readManifest('my-skill'));
    const normalizedPath = path.normalize(globalPath);
    expect(manifest.installs[normalizedPath].version).toBe('2');
  });

  it('同 name 不同 path → manifest 内有两条 install', async () => {
    const projectPath = path.join('/projects/foo', '.claude', 'skills', 'my-skill');
    await addInstall('my-skill', globalPath, makeEntry({ version: '1' }));
    await addInstall('my-skill', projectPath, makeEntry({ version: '1' }));
    const manifest = expectManifest(await readManifest('my-skill'));
    expect(Object.keys(manifest.installs)).toHaveLength(2);
  });

  it('addInstall 持久化 authorId 字段', async () => {
    await addInstall('my-skill', globalPath, makeEntry({ authorId: 'user_123' }));
    const manifest = expectManifest(await readManifest('my-skill'));
    const normalizedPath = path.normalize(globalPath);
    expect(manifest.installs[normalizedPath].authorId).toBe('user_123');
  });

  it('addInstall 同步写 backup manifest，防止旧版误删主 registry 后永久丢失', async () => {
    const entry = makeEntry({ authorId: 'user_123' });
    await addInstall('my-skill', globalPath, entry);

    expect(fs.existsSync(manifestPath('my-skill'))).toBe(true);
    expect(fs.existsSync(backupManifestPath('my-skill'))).toBe(true);
    expect(readJson(backupManifestPath('my-skill'))).toEqual(readJson(manifestPath('my-skill')));
  });

  it('backup manifest 写失败不影响主 registry 写入', async () => {
    const backupRoot = path.join(userDataDir, 'skillhub', 'manifests-backup');
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.mkdirSync(backupManifestPath('my-skill'), { recursive: true });

    await expect(addInstall('my-skill', globalPath, makeEntry())).resolves.toBeUndefined();

    const manifest = expectManifest(await readManifest('my-skill'));
    expect(manifest.installs[path.normalize(globalPath)]).toBeTruthy();
    expect(fs.existsSync(manifestPath('my-skill'))).toBe(true);
  });

  it('manifest 文件存在但 skillName 不符 → 抛 REGISTRY_CORRUPTED', async () => {
    // 先写一个正常的文件
    await addInstall('my-skill', globalPath, makeEntry());
    // 再手动改 skillName 字段
    const root = path.join(userDataDir, 'skillhub', 'manifests');
    const filePath = path.join(root, 'my-skill.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    raw.skillName = 'tampered-name';
    fs.writeFileSync(filePath, JSON.stringify(raw), 'utf-8');

    await expect(addInstall('my-skill', globalPath, makeEntry())).rejects.toMatchObject({
      code: 'REGISTRY_CORRUPTED',
    });
  });
});

describe('catalog scope migration', () => {
  it('migrates and persists a released-client entry while holding the service lock', async () => {
    fs.mkdirSync(path.dirname(manifestPath('legacy-skill')), { recursive: true });
    const installPath = path.join('/projects/legacy', '.agents', 'skills', 'legacy-skill');
    fs.writeFileSync(manifestPath('legacy-skill'), JSON.stringify({
      schemaVersion: 1,
      skillName: 'legacy-skill',
      installs: { [installPath]: makeEntry({ catalogScope: undefined, catalogScopeMigrated: undefined }) },
    }));

    const manifest = expectManifest(await readManifest('legacy-skill'));

    expect(manifest.installs[installPath]).toMatchObject({
      catalogScope: 'team',
      catalogScopeMigrated: true,
    });
    expect(readJson(manifestPath('legacy-skill'))).toEqual(manifest);
    expect(readJson(backupManifestPath('legacy-skill'))).toEqual(manifest);
  });

  it('migrates each downgrade-written entry even when an old top-level marker remains', async () => {
    fs.mkdirSync(path.dirname(manifestPath('downgrade-skill')), { recursive: true });
    const nativePath = path.join('/projects/native', '.agents', 'skills', 'downgrade-skill');
    const downgradedPath = path.join('/projects/old-client', '.agents', 'skills', 'downgrade-skill');
    fs.writeFileSync(manifestPath('downgrade-skill'), JSON.stringify({
      schemaVersion: 1,
      catalogScopeMigrated: true,
      skillName: 'downgrade-skill',
      installs: {
        [nativePath]: makeEntry({ catalogScope: undefined, catalogScopeMigrated: true }),
        [downgradedPath]: makeEntry({ catalogScope: undefined, catalogScopeMigrated: undefined }),
      },
    }));

    const manifest = expectManifest(await readManifest('downgrade-skill'));

    expect(manifest.installs[nativePath].catalogScope).toBeUndefined();
    expect(manifest.installs[downgradedPath]).toMatchObject({
      catalogScope: 'team',
      catalogScopeMigrated: true,
    });
    expect(manifest).not.toHaveProperty('catalogScopeMigrated');
  });
});

describe('updateInstall', () => {
  it('存在的 entry → 部分更新', async () => {
    await addInstall(
      'my-skill',
      globalPath,
      makeEntry({ version: '1', folderHash: 'old', authorId: 'user_alice' }),
    );
    await updateInstall('my-skill', globalPath, { version: '2', folderHash: 'new' });
    const entry = expectInstall(await getInstall('my-skill', globalPath));
    expect(entry.version).toBe('2');
    expect(entry.folderHash).toBe('new');
    // 未更新字段保持原样
    expect(entry.authorId).toBe('user_alice');
  });

  it('updateInstall 可以单独刷新 authorId', async () => {
    await addInstall('my-skill', globalPath, makeEntry({ authorId: '' }));
    await updateInstall('my-skill', globalPath, { authorId: 'user_bob' });
    const entry = expectInstall(await getInstall('my-skill', globalPath));
    expect(entry.authorId).toBe('user_bob');
    expect(readJson(backupManifestPath('my-skill'))).toEqual(readJson(manifestPath('my-skill')));
  });

  it('可见性迁移可清除目录作用域且不会被旧数据迁移再次回填', async () => {
    await addInstall('my-skill', globalPath, makeEntry({ catalogScope: 'market' }));

    await updateCatalogScopeForSkill('my-skill', undefined, 'market');

    expect((await getInstall('my-skill', globalPath))?.catalogScope).toBeUndefined();
    expect((await getInstall('my-skill', globalPath))?.catalogScopeMigrated).toBe(true);
    expect((await getInstall('my-skill', globalPath))?.catalogScope).toBeUndefined();
  });

  it('可见性迁移只更新来源目录相同的安装记录', async () => {
    const teamPath = path.join('/projects/team', '.agents', 'skills', 'my-skill');
    await addInstall('my-skill', globalPath, makeEntry({ catalogScope: 'market' }));
    await addInstall('my-skill', teamPath, makeEntry({ catalogScope: 'team' }));

    await updateCatalogScopeForSkill('my-skill', undefined, 'market');

    expect((await getInstall('my-skill', globalPath))?.catalogScope).toBeUndefined();
    expect((await getInstall('my-skill', teamPath))?.catalogScope).toBe('team');
  });

  it('不存在的 installPath → 抛 REGISTRY_IO_FAILED', async () => {
    await expect(
      updateInstall('my-skill', '/nonexistent/path', { version: '2' }),
    ).rejects.toMatchObject({ code: 'REGISTRY_IO_FAILED' });
  });
});

describe('removeInstall', () => {
  it('删掉一条 entry，其他留存', async () => {
    const projectPath = path.join('/projects/foo', '.claude', 'skills', 'my-skill');
    await addInstall('my-skill', globalPath, makeEntry());
    await addInstall('my-skill', projectPath, makeEntry());
    await removeInstall('my-skill', globalPath);
    const manifest = expectManifest(await readManifest('my-skill'));
    const normalizedGlobal = path.normalize(globalPath);
    expect(manifest.installs[normalizedGlobal]).toBeUndefined();
    expect(Object.keys(manifest.installs)).toHaveLength(1);
  });

  it('删最后一条 entry → 整个文件被 unlink', async () => {
    await addInstall('my-skill', globalPath, makeEntry());
    await removeInstall('my-skill', globalPath);
    const manifest = await readManifest('my-skill');
    expect(manifest).toBeNull();
    // 文件确实不存在
    expect(fs.existsSync(manifestPath('my-skill'))).toBe(false);
    expect(fs.existsSync(backupManifestPath('my-skill'))).toBe(false);
  });

  it('不存在的 (name, path) → no-op，不抛错', async () => {
    await expect(removeInstall('nonexistent-skill', '/some/path')).resolves.toBeUndefined();
  });
});

describe('listAllInstalls', () => {
  it('空目录 → 空数组', async () => {
    const result = await listAllInstalls();
    expect(result).toEqual([]);
  });

  it('does not trust an unlocked directory-scan snapshot before migration writeback', async () => {
    await addInstall('my-skill', globalPath, makeEntry({ version: '2', catalogScope: 'market' }));
    const manifestIO = await import('../manifestIO.js');
    vi.spyOn(manifestIO, 'listAllFiles').mockResolvedValue([{
      skillName: 'my-skill',
      manifest: {
        schemaVersion: 1,
        skillName: 'my-skill',
        installs: { [globalPath]: makeEntry({ version: '1' }) },
      },
    }]);

    const installs = await listAllInstalls();

    expect(installs).toHaveLength(1);
    expect(installs[0]?.entry.version).toBe('2');
  });

  it('跨多个 manifest 文件展平所有 install', async () => {
    const pathA = path.join('/home/sam/.claude/skills/skill-a');
    const pathB1 = path.join('/projects/p1/.claude/skills/skill-b');
    const pathB2 = path.join('/projects/p2/.claude/skills/skill-b');
    await addInstall('skill-a', pathA, makeEntry({ version: '1' }));
    await addInstall('skill-b', pathB1, makeEntry({ version: '2' }));
    await addInstall('skill-b', pathB2, makeEntry({ version: '3' }));

    const all = await listAllInstalls();
    expect(all).toHaveLength(3);

    const names = all.map((r) => r.skillName).sort();
    expect(names).toEqual(['skill-a', 'skill-b', 'skill-b']);
  });

  it('主 manifest 被旧版删掉后，listAllInstalls 会从 backup 恢复并返回记录', async () => {
    const pathA = createSkillDir('skill-a');
    await addInstall('skill-a', pathA, makeEntry({ version: '1' }));
    fs.unlinkSync(manifestPath('skill-a'));

    const all = await listAllInstalls();

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ skillName: 'skill-a', installPath: path.normalize(pathA) });
    expect(fs.existsSync(manifestPath('skill-a'))).toBe(true);
    expect(readJson(manifestPath('skill-a'))).toEqual(readJson(backupManifestPath('skill-a')));
  });
});

describe('backup restore compatibility', () => {
  it('主 manifest 被旧版删掉后，readManifest 会从 backup 恢复', async () => {
    const installPath = createSkillDir('my-skill');
    await addInstall('my-skill', installPath, makeEntry({ version: '1' }));
    fs.unlinkSync(manifestPath('my-skill'));

    const manifest = expectManifest(await readManifest('my-skill'));

    expect(manifest.installs[path.normalize(installPath)].version).toBe('1');
    expect(fs.existsSync(manifestPath('my-skill'))).toBe(true);
    expect(readJson(manifestPath('my-skill'))).toEqual(readJson(backupManifestPath('my-skill')));
  });

  it('backup 里的路径都不存在时不会恢复，避免卸载后复活', async () => {
    const installPath = createSkillDir('missing-skill');
    await addInstall('missing-skill', installPath, makeEntry());
    fs.unlinkSync(manifestPath('missing-skill'));
    fs.rmSync(installPath, { recursive: true, force: true });

    const manifest = await readManifest('missing-skill');

    expect(manifest).toBeNull();
    expect(fs.existsSync(manifestPath('missing-skill'))).toBe(false);
  });

  it('主 manifest 损坏时仍然抛 REGISTRY_CORRUPTED，不用 backup 静默覆盖', async () => {
    await addInstall('my-skill', globalPath, makeEntry());
    const raw = readJson(manifestPath('my-skill')) as Record<string, unknown>;
    raw.skillName = 'tampered-name';
    fs.writeFileSync(manifestPath('my-skill'), JSON.stringify(raw), 'utf-8');

    await expect(readManifest('my-skill')).rejects.toMatchObject({
      code: 'REGISTRY_CORRUPTED',
    });
  });
});

describe('并发安全', () => {
  it('同 skillName 多次并发 addInstall → 最终 installs 条目数正确（无竞态）', async () => {
    // withLock 的 100 并发压力在 lock.test.ts 覆盖；这里验证 registry IO 接锁后不会丢 entry。
    const installCount = 20;
    const tasks = Array.from({ length: installCount }, (_, i) => {
      const p = path.join(`/projects/p${i}`, '.claude', 'skills', 'concurrent-skill');
      return addInstall('concurrent-skill', p, makeEntry({ version: String(i) }));
    });

    await Promise.all(tasks);

    const manifest = expectManifest(await readManifest('concurrent-skill'));
    // 不同路径都应该保留下来，不能被最后一次写覆盖成单条。
    expect(Object.keys(manifest.installs)).toHaveLength(installCount);
  });
});
