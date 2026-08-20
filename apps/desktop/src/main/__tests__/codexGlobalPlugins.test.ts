import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  codexGlobalPluginsPaths,
  retireCodexGlobalPluginsBridge,
} from '../maker-host/codex-global-plugins';

const tempRoots: string[] = [];

async function makeTmpDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-plugin-retirement-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('retireCodexGlobalPluginsBridge', () => {
  it('is a no-op when the isolated plugin cache does not exist', async () => {
    const root = await makeTmpDir();
    const result = await retireCodexGlobalPluginsBridge(
      path.join(root, 'codex-home'),
      { homeDir: path.join(root, 'home') },
    );

    expect(result).toEqual({
      changed: false,
      removedMarketplaces: [],
      warnings: [],
    });
  });

  it('removes only marketplace links projected from the user Codex cache', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'codex-home');
    const paths = codexGlobalPluginsPaths(codexHome, homeDir);
    const source = path.join(paths.sourceCacheDir, 'personal');
    const unrelated = path.join(root, 'unrelated-marketplace');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });
    await fs.mkdir(paths.cacheDir, { recursive: true });
    await fs.symlink(
      source,
      path.join(paths.cacheDir, 'personal'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.symlink(
      unrelated,
      path.join(paths.cacheDir, 'unrelated'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await retireCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result).toEqual({
      changed: true,
      removedMarketplaces: ['personal'],
      warnings: [],
    });
    await expect(fs.lstat(path.join(paths.cacheDir, 'personal'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.lstat(path.join(paths.cacheDir, 'unrelated'))).resolves.toBeDefined();
    await expect(fs.stat(source)).resolves.toBeDefined();
  });

  it('removes marked Cindy overlays but preserves Codex-managed real directories', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'codex-home');
    const paths = codexGlobalPluginsPaths(codexHome, homeDir);
    const source = path.join(paths.sourceCacheDir, 'personal');
    const overlay = path.join(paths.cacheDir, 'personal');
    const remote = path.join(paths.cacheDir, 'openai-curated-remote');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(overlay, { recursive: true });
    await fs.mkdir(remote, { recursive: true });
    await fs.writeFile(
      path.join(overlay, '.cindy-capability-routing.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        source,
        sourceSnapshot: 'snapshot',
        skills: [],
      })}\n`,
      'utf8',
    );
    await fs.writeFile(path.join(remote, 'keep.txt'), 'keep', 'utf8');

    const result = await retireCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.removedMarketplaces).toEqual(['personal']);
    await expect(fs.lstat(overlay)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(remote, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('preserves a marked directory whose source is outside the user Codex cache', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'codex-home');
    const paths = codexGlobalPluginsPaths(codexHome, homeDir);
    const directory = path.join(paths.cacheDir, 'custom');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, '.cindy-capability-routing.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        source: path.join(root, 'outside'),
        sourceSnapshot: 'snapshot',
        skills: [],
      })}\n`,
      'utf8',
    );

    const result = await retireCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(false);
    await expect(fs.lstat(directory)).resolves.toBeDefined();
  });
});
