import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provisionBuiltinGhosts } from '../builtinGhostProvisioner.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-builtin-locale-'));
  tempDirs.push(dir);
  return dir;
}

async function writeBasicGhost(dir: string, id: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
  await fs.promises.writeFile(
    path.join(dir, 'ghost.json'),
    JSON.stringify({
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'run', description: 'Run' }],
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe('builtinGhostProvisioner locale validation', () => {
  it('locale 资源翻译错位时跳过官方种子，不把损坏翻译播种给用户', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    const seedDir = path.join(seedRoot, 'localized-seed');
    await fs.promises.mkdir(path.join(seedDir, 'locales'), { recursive: true });
    await fs.promises.writeFile(path.join(seedDir, 'main.js'), '// brain');
    await fs.promises.writeFile(
      path.join(seedDir, 'ghost.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'localized-seed',
        name: 'Base',
        version: '1.0.0',
        entry: 'main.js',
        slots: ['tool'],
        tools: [{ name: 'run', description: 'Base tool' }],
        locales: { en: 'locales/en.json' },
      }),
    );
    await fs.promises.writeFile(
      path.join(seedDir, 'locales', 'en.json'),
      JSON.stringify({ name: 'English', tools: { nope: { description: 'x' } } }),
    );
    const warn = vi.fn();

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      log: { info: vi.fn(), warn },
    });

    expect(outcome).toMatchObject({
      installed: [],
      updated: [],
      skipped: ['localized-seed'],
    });
    expect(fs.existsSync(path.join(repoRoot, 'localized-seed'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'builtin seed skipped: invalid locale resources',
      expect.objectContaining({ reason: expect.stringContaining('locale.tools 含未知工具') }),
    );
  });
});

describe('builtinGhostProvisioner removal boundary', () => {
  it('把孤儿 seed 包删除委托给宿主提供的事务边界', async () => {
    const root = await makeTempDir();
    const seedRoot = path.join(root, 'seeds');
    const repoRoot = path.join(root, 'installed');
    await writeBasicGhost(path.join(seedRoot, 'kept-seed'), 'kept-seed');
    await writeBasicGhost(path.join(repoRoot, 'removed-seed'), 'removed-seed');
    await fs.promises.writeFile(
      path.join(repoRoot, '.builtin-provisioning.json'),
      JSON.stringify({ removed: [], seeded: ['removed-seed'] }),
    );
    const removeInstalled = vi.fn(async (_id: string, removePackage: () => Promise<void>) => {
      await removePackage();
    });

    const outcome = await provisionBuiltinGhosts({
      seedRootDirs: [seedRoot],
      repoRootDir: repoRoot,
      removeInstalled,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(removeInstalled).toHaveBeenCalledOnce();
    expect(removeInstalled).toHaveBeenCalledWith('removed-seed', expect.any(Function));
    expect(outcome.removed).toContain('removed-seed');
    expect(fs.existsSync(path.join(repoRoot, 'removed-seed'))).toBe(false);
  });
});
