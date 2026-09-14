/**
 * manifestIO.test.ts — 文件 IO 层单测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── mock electron ────────────────────────────────────────────────────────────

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir;
      return userDataDir;
    },
  },
}));

// ── test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  userDataDir = path.join(os.tmpdir(), `registry-io-test-${randomUUID()}`);
});

afterEach(() => {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// late import 保证 mock 先生效
let readFile: typeof import('../manifestIO.js').readFile;
let writeFileAtomic: typeof import('../manifestIO.js').writeFileAtomic;
let unlinkFile: typeof import('../manifestIO.js').unlinkFile;
let listAllFiles: typeof import('../manifestIO.js').listAllFiles;
let manifestsRoot: typeof import('../manifestIO.js').manifestsRoot;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../manifestIO.js');
  readFile = mod.readFile;
  writeFileAtomic = mod.writeFileAtomic;
  unlinkFile = mod.unlinkFile;
  listAllFiles = mod.listAllFiles;
  manifestsRoot = mod.manifestsRoot;
});

import type { StoredManifest } from '../types.js';

function makeManifest(skillName: string, overrides?: Partial<StoredManifest>): StoredManifest {
  return {
    schemaVersion: 1,
    skillName,
    installs: {
      [path.normalize(`/home/sam/.claude/skills/${skillName}`)]: {
        version: '3',
        authorId: 'user_lizi',
        folderHash: 'abc123',
        installedAt: 1714000000,
        updatedAt: 1714000000,
        catalogScope: 'team',
        catalogScopeMigrated: true,
      },
    },
    ...overrides,
  };
}

describe('manifestIO', () => {
  describe('readFile', () => {
    it('文件不存在 → null', async () => {
      const result = await readFile('nonexistent');
      expect(result).toBeNull();
    });

    it('write + read roundtrip 正常', async () => {
      const m = makeManifest('my-skill');
      await writeFileAtomic('my-skill', m);
      const back = await readFile('my-skill');
      expect(back).toEqual(m);
    });

    it('JSON 损坏 → null + 不抛', async () => {
      const root = manifestsRoot();
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'broken-skill.json'), '{not valid json', 'utf-8');
      const result = await readFile('broken-skill');
      expect(result).toBeNull();
    });

    it('旧 registry 读取保持纯 IO，不在未加锁路径写回迁移', async () => {
      const root = manifestsRoot();
      fs.mkdirSync(root, { recursive: true });
      // 模拟一份只含 isMine 没 authorId 的老数据
      const legacyManifest = {
        schemaVersion: 1,
        skillName: 'legacy-skill',
        installs: {
          [path.normalize('/home/sam/.claude/skills/legacy-skill')]: {
            version: '1',
            isMine: true,
            folderHash: 'old-hash',
            installedAt: 1714000000,
            updatedAt: 1714000000,
          },
        },
      };
      fs.writeFileSync(
        path.join(root, 'legacy-skill.json'),
        JSON.stringify(legacyManifest),
        'utf-8',
      );
      const result = await readFile('legacy-skill');
      expect(result).not.toBeNull();
      const installEntry = result!.installs[path.normalize('/home/sam/.claude/skills/legacy-skill')];
      expect(installEntry.authorId).toBeUndefined();
      expect(installEntry.catalogScope).toBeUndefined();
      expect((installEntry as unknown as Record<string, unknown>).isMine).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(path.join(root, 'legacy-skill.json'), 'utf-8'));
      expect(persisted).toEqual(legacyManifest);
    });

    it('skillName 字段不符 → 抛 RegistryError CORRUPTED', async () => {
      const root = manifestsRoot();
      fs.mkdirSync(root, { recursive: true });
      // 写一个 skillName 字段与文件名不匹配的文件
      const badManifest: StoredManifest = {
        schemaVersion: 1,
        skillName: 'wrong-name',
        installs: {},
      };
      fs.writeFileSync(
        path.join(root, 'right-name.json'),
        JSON.stringify(badManifest),
        'utf-8',
      );
      await expect(readFile('right-name')).rejects.toMatchObject({
        code: 'REGISTRY_CORRUPTED',
      });
    });
  });

  describe('writeFileAtomic', () => {
    it('写入后文件存在且内容正确', async () => {
      const m = makeManifest('write-test');
      await writeFileAtomic('write-test', m);
      const root = manifestsRoot();
      const raw = fs.readFileSync(path.join(root, 'write-test.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual(m);
    });

    it('rename 失败时 tmp 文件被清理，抛 REGISTRY_IO_FAILED', async () => {
      // 先 ensureRoot 以便目录存在
      const m = makeManifest('atomic-fail');
      // spy fs.promises.rename 抛错
      const renameOrig = fs.promises.rename.bind(fs.promises);
      let firstRename = true;
      const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dest) => {
        if (firstRename && String(src).includes('.tmp.')) {
          firstRename = false;
          throw new Error('simulated rename error');
        }
        return renameOrig(src, dest);
      });

      try {
        await expect(writeFileAtomic('atomic-fail', m)).rejects.toMatchObject({
          code: 'REGISTRY_IO_FAILED',
        });
        // tmp 文件应该被清理（不存在任何 .tmp. 文件）
        const root = manifestsRoot();
        const files = fs.readdirSync(root);
        const tmpFiles = files.filter((f) => f.includes('.tmp.'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('unlinkFile', () => {
    it('文件存在 → 成功删除', async () => {
      await writeFileAtomic('to-delete', makeManifest('to-delete'));
      await unlinkFile('to-delete');
      const root = manifestsRoot();
      expect(fs.existsSync(path.join(root, 'to-delete.json'))).toBe(false);
    });

    it('文件不存在 → no-op，不抛错', async () => {
      await expect(unlinkFile('already-gone')).resolves.toBeUndefined();
    });
  });

  describe('listAllFiles', () => {
    it('空目录 → 空数组', async () => {
      const result = await listAllFiles();
      expect(result).toEqual([]);
    });

    it('多个文件 → 全部返回', async () => {
      await writeFileAtomic('skill-a', makeManifest('skill-a'));
      await writeFileAtomic('skill-b', makeManifest('skill-b'));
      const result = await listAllFiles();
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.skillName).sort();
      expect(names).toEqual(['skill-a', 'skill-b']);
    });

    it('单文件损坏 → 跳过，不影响其他', async () => {
      await writeFileAtomic('skill-good', makeManifest('skill-good'));
      const root = manifestsRoot();
      // 直接写一个 JSON 语法错误文件
      fs.writeFileSync(path.join(root, 'skill-bad.json'), '{bad json', 'utf-8');
      const result = await listAllFiles();
      expect(result).toHaveLength(1);
      expect(result[0].skillName).toBe('skill-good');
    });

    it('目录不存在 → 返回空数组（不抛）', async () => {
      // 不创建目录，直接 list
      const result = await listAllFiles();
      expect(result).toEqual([]);
    });
  });
});
