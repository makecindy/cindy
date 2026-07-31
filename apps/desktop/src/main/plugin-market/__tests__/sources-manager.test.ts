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

    const slot = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );
    const pointer = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(fs.existsSync(path.join(slot, 'versions', pointer, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
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

  it('keeps the previous cache when the fast-forwarded marketplace content is invalid', async () => {
    const root = makeRoot();
    const executor: GitExecutor = async (args, opts) => {
      if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'clone') {
        writeMarketplace(String(args[args.length - 1]), 'hub', [{ rel: 'p', id: 'alpha' }]);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'pull') {
        // 快进成功，但新内容删除了 marketplace.json（在 staging 工作目录里破坏）。
        const cwd = String(opts?.cwd ?? '');
        fs.rmSync(`${cwd}/.agents/plugins/marketplace.json`, { force: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: 'def456\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const manager = makeManager(root, executor);
    await manager.addSource({ source: 'openai/plugins' });

    await expect(manager.refreshSource('hub')).rejects.toMatchObject({
      code: 'MARKET_MANIFEST_MISSING',
    });
    // 旧缓存未被损坏的快进污染：列表仍返回插件计数。
    const listed = await manager.listSources();
    expect(listed[0]?.pluginCount).toBe(1);
    expect(listed[0]?.status).toBe('ok');
  });

  it('keeps the previous cache when the re-cloned marketplace is invalid', async () => {
    const root = makeRoot();
    let failFetch = false;
    const executor: GitExecutor = async (args) => {
      if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(args[args.length - 1]);
        if (failFetch) {
          // 重克隆拿到的远端已损坏：没有 marketplace.json。
          fs.mkdirSync(dest, { recursive: true });
        } else {
          writeMarketplace(dest, 'hub', [{ rel: 'p', id: 'alpha' }]);
        }
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
    await expect(manager.refreshSource('hub')).rejects.toMatchObject({
      code: 'MARKET_MANIFEST_MISSING',
    });
    // 旧缓存仍然可用：列表照常返回插件计数。
    const listed = await manager.listSources();
    expect(listed[0]?.pluginCount).toBe(1);
  });

  it('migrates a legacy single-dir cache into the versioned layout on read', async () => {
    const root = makeRoot();
    const slug = marketCloneSlug('hub', {
      type: 'git',
      url: 'https://github.com/openai/plugins.git',
      sparsePaths: [],
    });
    // 旧布局:槽目录直接是缓存(含 .agents)。
    const slot = path.join(root, 'sources', slug);
    writeMarketplace(slot, 'hub', [{ rel: 'p', id: 'alpha' }]);
    const store = new MarketSourceStore(path.join(root, 'sources.v1.json'));
    store.add({
      name: 'hub',
      addedAt: '2026-07-30T00:00:00.000Z',
      lastSyncedAt: '2026-07-30T01:00:00.000Z',
      lastRevision: 'abc123',
      source: { type: 'git', url: 'https://github.com/openai/plugins.git', sparsePaths: [] },
    });
    const manager = new MarketSourceManager({
      store,
      cloneRoot: path.join(root, 'sources'),
      homeDir: root,
    });

    const listed = await manager.listSources();
    expect(listed[0]?.status).toBe('ok');
    expect(listed[0]?.pluginCount).toBe(1);
    const pointer = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(fs.existsSync(path.join(slot, 'versions', pointer, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it('keeps serving the current version while a refresh validates a new one', async () => {
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

    const slot = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );
    const before = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();

    // 刷新成功后指针切到新版本,旧版本目录被清理,来源持续可读。
    failFetch = true;
    const refreshed = await manager.refreshSource('hub');
    expect(refreshed.pluginCount).toBe(1);
    const after = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(after).not.toBe(before);
    expect(fs.existsSync(path.join(slot, 'versions', before))).toBe(false);
    expect(fs.existsSync(path.join(slot, 'versions', after, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it('does not delete the previous version while it is being read', async () => {
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

    const slot = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );
    const before = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    // 模拟旧版本正被并发读取:放一个 .reading 标记。
    fs.writeFileSync(path.join(slot, 'versions', before, '.reading-test'), '');

    failFetch = true;
    await manager.refreshSource('hub');
    // 旧版本有活跃读者,本次跳过删除;指针已切到新版本。
    const after = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(after).not.toBe(before);
    expect(fs.existsSync(path.join(slot, 'versions', before))).toBe(true);
  });
});
