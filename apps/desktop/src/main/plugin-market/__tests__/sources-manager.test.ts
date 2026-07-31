import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MarketSourceManager, marketCloneSlug } from '../sources/index';
import type { GitExecutor } from '../sources/git';
import { MarketSourceStore } from '../sources/store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-manager-'));
  roots.push(root);
  return root;
}

function writeMarketplace(dir: string, name: string, plugins: Array<{ rel: string; id: string }>) {
  for (const plugin of plugins) {
    const pluginDir = path.join(dir, ...plugin.rel.split('/'));
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify({ schemaVersion: 2, id: plugin.id, name: `Plugin ${plugin.id}`, version: '1.0.0', entry: 'main.js', slots: ['notify'] }),
    );
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '// entry');
  }
  const manifestDir = path.join(dir, '.agents', 'plugins');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'marketplace.json'),
    JSON.stringify({
      name,
      plugins: plugins.map((plugin) => ({ name: plugin.id, source: plugin.rel })),
    }),
  );
}

function makeManager(root: string, gitExecutor?: GitExecutor) {
  return new MarketSourceManager({
    store: new MarketSourceStore(path.join(root, 'sources.v1.json')),
    cloneRoot: path.join(root, 'sources'),
    homeDir: root,
    ...(gitExecutor ? { gitExecutor } : {}),
  });
}

/** Git 假执行器：版本探测通过，clone 时向目标目录写入一个市场夹具。 */
function fakeGit(marketName: string, plugins: Array<{ rel: string; id: string }>) {
  const calls: string[][] = [];
  const executor: GitExecutor = async (args) => {
    calls.push([...args]);
    if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
    if (args[0] === 'clone') {
      const dest = String(args[args.length - 1]);
      writeMarketplace(dest, marketName, plugins);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { executor, calls };
}

describe('MarketSourceManager local sources', () => {
  it('adds a local marketplace and lists it with the plugin count', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', [{ rel: 'plugins/a', id: 'alpha' }]);
    const manager = makeManager(root);

    const added = await manager.addSource({ source: market });
    expect(added).toMatchObject({
      name: 'local-lib',
      pluginCount: 1,
      status: 'ok',
    });
    expect(added.source).toEqual({ type: 'local', path: market });

    const list = await manager.listSources();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('local-lib');
  });

  it('rejects a local source that is not a directory', async () => {
    const manager = makeManager(makeRoot());
    await expect(
      manager.addSource({ source: path.join(makeRoot(), 'missing') }),
    ).rejects.toMatchObject({ code: 'MARKET_SOURCE_INVALID' });
  });

  it('rejects duplicate sources and duplicate marketplace names', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', []);
    const manager = makeManager(root);

    await manager.addSource({ source: market });
    await expect(manager.addSource({ source: market })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });

    const other = path.join(root, 'other-market');
    writeMarketplace(other, 'local-lib', []);
    await expect(manager.addSource({ source: other })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('removes sources and keeps local directories untouched', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', []);
    const manager = makeManager(root);

    await manager.addSource({ source: market });
    await expect(manager.removeSource('local-lib')).resolves.toEqual({ ok: true });
    expect(await manager.listSources()).toEqual([]);
    expect(fs.existsSync(path.join(market, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    await expect(manager.removeSource('local-lib')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('marks sources with vanished roots as errors in the list view', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', [{ rel: 'p', id: 'alpha' }]);
    const manager = makeManager(root);
    await manager.addSource({ source: market });

    fs.rmSync(market, { recursive: true, force: true });
    const list = await manager.listSources();
    expect(list[0]?.status).toBe('error');
    expect(list[0]?.errorCode).toBe('MARKET_SOURCE_INVALID');
  });

  it('refreshes local sources by rescanning the manifest', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', []);
    const manager = makeManager(root);
    await manager.addSource({ source: market });

    writeMarketplace(market, 'local-lib', [{ rel: 'p', id: 'alpha' }]);
    const refreshed = await manager.refreshSource('local-lib');
    expect(refreshed.pluginCount).toBe(1);
    expect(refreshed.lastSyncedAt).not.toBeNull();
  });
});

describe('MarketSourceManager git sources', () => {
  it('clones into the derived cache directory on add', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'plugins/a', id: 'alpha' }]);
    const manager = makeManager(root, executor);

    const added = await manager.addSource({ source: 'openai/plugins' });
    expect(added).toMatchObject({ name: 'hub', pluginCount: 1, lastRevision: 'abc123' });

    const cloneDir = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );
    expect(fs.existsSync(path.join(cloneDir, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    // 临时 incoming 目录不残留
    expect(
      fs.readdirSync(path.join(root, 'sources')).filter((name) => name.startsWith('.incoming')),
    ).toEqual([]);
  });

  it('blocks git sources when git is unavailable', async () => {
    const root = makeRoot();
    const executor: GitExecutor = async () => {
      throw new Error('spawn git ENOENT');
    };
    const manager = makeManager(root, executor);
    await expect(manager.addSource({ source: 'openai/plugins' })).rejects.toMatchObject({
      code: 'MARKET_GIT_UNAVAILABLE',
    });
    expect(await manager.listSources()).toEqual([]);
  });

  it('rolls back the clone when the marketplace name conflicts', async () => {
    const root = makeRoot();
    const local = path.join(root, 'local-market');
    writeMarketplace(local, 'hub', []);
    const { executor } = fakeGit('hub', []);
    const manager = makeManager(root, executor);

    await manager.addSource({ source: local });
    await expect(manager.addSource({ source: 'openai/plugins' })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(fs.readdirSync(path.join(root, 'sources'))).toEqual([]);
  });

  it('removes the clone cache when the source is removed', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', []);
    const manager = makeManager(root, executor);
    await manager.addSource({ source: 'openai/plugins' });

    const cloneDir = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );
    expect(fs.existsSync(cloneDir)).toBe(true);
    await manager.removeSource('hub');
    expect(fs.existsSync(cloneDir)).toBe(false);
  });

  it('re-clones when fast-forward refresh fails', async () => {
    const root = makeRoot();
    let failFetch = false;
    const executor: GitExecutor = async (args) => {
      if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'clone') {
        writeMarketplace(String(args[args.length - 1]), 'hub', [{ rel: 'p', id: 'alpha' }]);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'pull' || args[0] === 'fetch') {
        if (failFetch) throw Object.assign(new Error('rejected'), { stderr: 'non-fast-forward' });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: 'def456\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const manager = makeManager(root, executor);
    await manager.addSource({ source: 'openai/plugins' });

    failFetch = true;
    const refreshed = await manager.refreshSource('hub');
    expect(refreshed.lastRevision).toBe('def456');
    expect(refreshed.pluginCount).toBe(1);
  });
});
