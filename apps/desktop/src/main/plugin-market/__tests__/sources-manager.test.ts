import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketSourceManager, marketCloneSlug } from '../sources/index';
import type { GitExecutor } from '../sources/git';
import { releaseCachePath, retainCachePath } from '../sources/cacheLease';
import { MarketSourceStore } from '../sources/store';
import { createMarketSourceIdOf } from '../sources/sourceId';
import { marketSourceKey, pluginMarketFetchAddress } from '../../../shared/pluginMarket';

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('../../logger.js', () => ({
  createLogger: () => {
    const record = (...args: unknown[]) => { logged.push(args); };
    return { trace: record, debug: record, info: record, warn: record, error: record, fatal: record };
  },
}));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** 等待推迟清理这类"引用释放后异步执行"的副作用落地。 */
async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
      skippedCount: 0,
      unreadableCount: 0,
      status: 'ok',
    });
    expect(added.source).toEqual({ type: 'local', path: market });

    const list = await manager.listSources();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('local-lib');
  });

  it('reports skipped entries separately from an empty marketplace', async () => {
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', [{ rel: 'plugins/a', id: 'alpha' }]);
    const manifestPath = path.join(market, '.agents', 'plugins', 'marketplace.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      plugins: Array<{ name: string; source: string }>;
    };
    manifest.plugins.push({ name: 'missing', source: 'plugins/missing' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = await makeManager(root).addSource({ source: market });
    expect(summary).toMatchObject({
      pluginCount: 1,
      skippedCount: 1,
      unreadableCount: 0,
      status: 'ok',
    });
  });

  it('surfaces the submodule-shaped empty market (entries declared, dirs empty) in add and refresh summaries', async () => {
    // Git submodule 未递归检出的典型形态:清单合法、插件目录存在但没有 ghost.json。
    // 不触发任何错误码,summary 必须给出 pluginCount 0 + 全额 skippedCount,
    // renderer 才有依据展示"插件目录为空(submodule)"的专门提示(B3)。
    const root = makeRoot();
    const market = path.join(root, 'my-market');
    writeMarketplace(market, 'local-lib', [{ rel: 'plugins/a', id: 'alpha' }]);
    // 掏空插件目录:目录保留,ghost.json 与入口都不在(= submodule 空壳)。
    fs.rmSync(path.join(market, 'plugins', 'a', 'ghost.json'));
    fs.rmSync(path.join(market, 'plugins', 'a', 'main.js'));
    const manager = makeManager(root);

    const added = await manager.addSource({ source: market });
    expect(added).toMatchObject({
      name: 'local-lib',
      pluginCount: 0,
      skippedCount: 1,
      unreadableCount: 0,
      status: 'ok',
      errorCode: null,
    });

    const refreshed = await manager.refreshSource('local-lib');
    expect(refreshed).toMatchObject({ pluginCount: 0, skippedCount: 1, unreadableCount: 0 });
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
    expect(list[0]?.skippedCount).toBe(0);
    expect(list[0]?.unreadableCount).toBe(0);
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

  it('prunes stale versions after the pointer switches, keeping only current', async () => {
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

    // 连续两次刷新:无人读取时每次切完指针就清掉非 current 版本。
    failFetch = true;
    await manager.refreshSource('hub');
    const second = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(second).not.toBe(before);
    await manager.refreshSource('hub');
    const third = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    // 历史版本(v1)已被延迟清理,current(v3)完整可读。
    expect(fs.existsSync(path.join(slot, 'versions', before))).toBe(false);
    expect(fs.existsSync(path.join(slot, 'versions', third, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it('keeps a version alive while a reader holds it, then prunes it on release', async () => {
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
    const held = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    const heldDir = path.join(slot, 'versions', held);

    // 读取方持有租约期间发生刷新:指针切走,但被持有的版本目录不得被清理,
    // 逐文件读取(安装打包的实质动作)必须全程可用。
    //
    // 刷新刻意走**另一个 manager 实例**:生产里 PluginMarketService 每次操作都
    // 新建一个 manager,租约注册表若是实例字段,安装持有的租约对刷新不可见。
    const refresher = makeManager(root, executor);
    failFetch = true;
    await manager.withDiscoveredSource('hub', async (discovered) => {
      expect(discovered.result.ok).toBe(true);
      const pluginDir = discovered.result.ok
        ? discovered.result.marketplace.plugins[0]!.dir
        : '';
      // discover 返回 realpath(macOS 下 /var → /private/var),按 realpath 比对。
      expect(pluginDir.startsWith(await fs.promises.realpath(heldDir))).toBe(true);

      await refresher.refreshSource('hub');
      const switched = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
      expect(switched).not.toBe(held);
      // 指针已切走,旧版本仍在,且包内容仍可逐文件读取。
      expect(fs.existsSync(heldDir)).toBe(true);
      expect(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8')).toContain('entry');
    });

    // 最后一个引用释放后,被推迟的清理执行完毕。
    await waitFor(() => !fs.existsSync(heldDir));
    expect(fs.existsSync(heldDir)).toBe(false);
  });

  it('keeps the activated version when persisting sync metadata fails', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
    const store = new MarketSourceStore(path.join(root, 'sources.v1.json'));
    const manager = new MarketSourceManager({
      store,
      cloneRoot: path.join(root, 'sources'),
      homeDir: root,
      gitExecutor: executor,
    });
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
    // 指针已切到新版本后元数据写入失败(磁盘满/只读/文件锁):必须如实报错,
    // 但绝不能删掉已生效的版本目录——否则指针指向不存在的目录,来源整体消失。
    store.update = () => {
      throw new Error('disk full');
    };
    await expect(manager.refreshSource('hub')).rejects.toThrow('disk full');

    const current = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(
      fs.existsSync(path.join(slot, 'versions', current, '.agents', 'plugins', 'marketplace.json')),
    ).toBe(true);
    // 来源仍然可发现(不会因为缓存被回收而变成 market root missing)。
    const discovered = await manager.discoverSource('hub');
    expect(discovered.result.ok).toBe(true);
  });

  it('defers removeSource cleanup while a reader still holds a cached version', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
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

    // 移除来源会整槽递归删除。并发的详情发现/安装打包可能正持有槽内某个版本
    // 目录,直接删会让它们读到一半 ENOENT —— 租约守卫必须按"重叠"判定挡住整槽删。
    // 移除刻意走另一个 manager 实例(与生产一致:每次操作新建 manager)。
    const remover = makeManager(root, executor);
    await manager.withDiscoveredSource('hub', async (discovered) => {
      expect(discovered.result.ok).toBe(true);
      const pluginDir = discovered.result.ok
        ? discovered.result.marketplace.plugins[0]!.dir
        : '';

      await remover.removeSource('hub');
      // 配置已移除(来源对用户即刻消失),但被持有的缓存内容仍可逐文件读取。
      expect(remover.getConfig('hub')).toBeNull();
      expect(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8')).toContain('entry');
    });

    // 租约释放后,被推迟的整槽删除执行完毕。
    await waitFor(() => !fs.existsSync(slot));
    expect(fs.existsSync(slot)).toBe(false);
  });

  it('keeps a re-added source when a deferred slot removal finally runs', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
    const store = new MarketSourceStore(path.join(root, 'sources.v1.json'));
    const deps = {
      store,
      cloneRoot: path.join(root, 'sources'),
      homeDir: root,
      gitExecutor: executor,
    };
    const manager = new MarketSourceManager(deps);
    await manager.addSource({ source: 'openai/plugins' });
    const config = manager.getConfig('hub')!;

    const slot = path.join(
      root,
      'sources',
      marketCloneSlug('hub', {
        type: 'git',
        url: 'https://github.com/openai/plugins.git',
        sparsePaths: [],
      }),
    );

    // 读取方持有租约时移除来源 → 整槽删除被推迟;用户随即重新添加同名同源,
    // 复用同一个槽。旧租约释放后那笔延迟删除若不再核对"槽是否仍被配置占用",
    // 就会把刚添加成功的缓存连 current 指针一起删掉(配置有效但市场内容不见了)。
    //
    // 这里刻意直接写回配置而不是走 addSource:addSource 自己也会排一笔带守卫的
    // 整槽删除,而推迟队列按路径为键、后写覆盖,那会掩盖 removeSource 这一侧
    // 是否带了守卫。
    const remover = new MarketSourceManager(deps);
    await manager.withDiscoveredSource('hub', async () => {
      await remover.removeSource('hub');
      store.add(config);
    });

    // 给延迟删除留出执行窗口,然后断言它放弃了删除。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const current = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(
      fs.existsSync(path.join(slot, 'versions', current, '.agents', 'plugins', 'marketplace.json')),
    ).toBe(true);
    const rediscovered = await remover.discoverSource('hub');
    expect(rediscovered.result.ok).toBe(true);
  });

  it('survives a queued slot removal that unblocks while the slot is being reused', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
    const store = new MarketSourceStore(path.join(root, 'sources.v1.json'));
    const deps = {
      store,
      cloneRoot: path.join(root, 'sources'),
      homeDir: root,
      gitExecutor: executor,
    };
    const manager = new MarketSourceManager(deps);
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
    const held = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    const heldDir = path.join(slot, 'versions', held);

    // 安装打包仍持有旧版本 → 移除来源时整槽删除只能进 deferred(尚未启动)。
    retainCachePath(heldDir);
    await new MarketSourceManager(deps).removeSource('hub');

    // 精确命中危险窗口:旧租约在"等完在途删除之后、写回配置之前"释放。此刻
    // slotIsConfigured() 还是 false,那笔 deferred 删除会启动并与落位并发。
    // 只有整个复用段持有槽租约才挡得住它。
    const realRename = fs.promises.rename;
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to).includes(`${path.sep}versions${path.sep}`)) {
          releaseCachePath(heldDir);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return realRename(from as never, to as never);
      });
    try {
      await new MarketSourceManager(deps).addSource({ source: 'openai/plugins' });
    } finally {
      renameSpy.mockRestore();
    }

    await new Promise((resolve) => setTimeout(resolve, 60));
    const current = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    expect(
      fs.existsSync(path.join(slot, 'versions', current, '.agents', 'plugins', 'marketplace.json')),
    ).toBe(true);
  });

  it('does not run a deferred deletion against a version referenced only by current.bak', async () => {
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
    const v1 = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
    const v1Dir = path.join(slot, 'versions', v1);

    // 读者持有 v1 → 刷新切到 v2,v1 的删除进推迟队列(skipIf = 是否为 current)。
    retainCachePath(v1Dir);
    failFetch = true;
    await manager.refreshSource('hub');

    // 并发刷新把指针切回 v1 后,Windows 备份交换失败:主文件缺失,唯一有效指针
    // 留在 current.bak。skipIf 执行时若裸读主文件,会把"v1 是 current"误判成
    // "不是",让推迟的删除把当前生效版本删掉。
    fs.writeFileSync(path.join(slot, 'current.bak'), v1);
    fs.rmSync(path.join(slot, 'current'));

    releaseCachePath(v1Dir);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fs.existsSync(path.join(v1Dir, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it('resolves the current version from current.bak when the pointer is missing', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
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
    // 备份交换连续失败时,唯一有效的指针留在 current.bak。只看主文件会把仍有完整
    // 版本的缓存判成缺失,整个来源报 market root missing。
    fs.renameSync(path.join(slot, 'current'), path.join(slot, 'current.bak'));

    const discovered = await manager.discoverSource('hub');
    expect(discovered.result.ok).toBe(true);
    // 读取入口顺带把指针恢复回主文件。
    expect(fs.existsSync(path.join(slot, 'current'))).toBe(true);
  });

  it('prunes dead incoming staging directories left by a killed refresh', async () => {
    const root = makeRoot();
    const { executor } = fakeGit('hub', [{ rel: 'p', id: 'alpha' }]);
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
    // 进程在刷新途中被杀会留下 incoming/ 残骸;下次刷新必须清掉,不能无界增长。
    const dead = path.join(slot, 'incoming', 'dead-uuid');
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, 'partial'), 'x');

    await manager.refreshSource('hub');
    await waitFor(() => !fs.existsSync(dead));
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('does not let concurrent refreshes prune each other staging directories', async () => {
    const root = makeRoot();
    // 两次刷新交错:第一次进入 clone 后挂住,让第二次完整跑完(切指针 + 清理),
    // 再放行第一次。第二次的清理不得删掉第一次正在写入的暂存目录。
    let gateClone: (() => void) | null = null;
    let holdNextClone = false;
    let stagingMarker = '';
    const executor: GitExecutor = async (args) => {
      if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(args[args.length - 1]);
        if (holdNextClone) {
          holdNextClone = false;
          // 真实 clone 会边下边写:先让暂存目录带着内容落盘,再挂住。
          fs.mkdirSync(dest, { recursive: true });
          stagingMarker = path.join(dest, 'partial-clone.txt');
          fs.writeFileSync(stagingMarker, 'in-flight');
          await new Promise<void>((resolve) => {
            gateClone = resolve;
          });
        }
        writeMarketplace(dest, 'hub', [{ rel: 'p', id: 'alpha' }]);
        return { stdout: '', stderr: '' };
      }
      // fetch 一律失败,迫使两次刷新都走重克隆路径。
      if (args[0] === 'pull' || args[0] === 'fetch') {
        throw Object.assign(new Error('rejected'), { stderr: 'non-fast-forward' });
      }
      if (args[0] === 'rev-parse') return { stdout: 'def456\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const manager = makeManager(root, executor);
    await manager.addSource({ source: 'openai/plugins' });

    holdNextClone = true;
    const slowRefresh = manager.refreshSource('hub');
    await waitFor(() => gateClone !== null);
    // 第二次刷新走另一个 manager 实例(与生产一致:每次操作新建 manager),
    // 完整跑完:切指针并清理非 current 版本。
    await makeManager(root, executor).refreshSource('hub');
    // 关键断言:清理不得碰到第一次正在写入的暂存目录(它还不是 current)。
    expect(fs.existsSync(stagingMarker)).toBe(true);

    gateClone!();
    // 被挂住的那次仍能完成。
    const summary = await slowRefresh;
    expect(summary.pluginCount).toBe(1);
    expect(summary.status).toBe('ok');
  });
});

/* 测试价值（PR #12731 维护者评审 2026-11-25 两轮 + Codex P1：回执核实要用 Host 生成、绑定实际取包端点的
 * 不透明来源标识；展示的仓库必须是 git 实际取包的地址，且要在取包实际发生的仓库上下文里采集；刷新落位的
 * 包必须就是本次获取的目标提交）
 * - 生产入口与可观察结果：MarketSourceManager.addSource / refreshSource / discoverSource 产出的 sourceIdentity
 *   与 sourceId（原样进入安装确认、市场条目与远程回执），createMarketSourceIdOf 的标识与密钥文件，以及刷新时
 *   是否改走全新克隆。
 * - 缺口：此前所有本地目录都是 {kind:'local'}；标识只看配置，同一配置改写到另一仓库仍相同；地址在无仓库的
 *   上下文采集，includeIf 只对缓存仓库生效时会记下错的地址；快进后 HEAD 未必是取到的目标。
 * - 最小失败输入：两个本地目录；同主机两个端口；同一配置先后改写到仓库 A、B；只改注入的令牌；includeIf 只在
 *   仓库上下文生效；取包前后解析不一致；刷新时上游停在本地 HEAD 的祖先；解析失败报错内容含令牌。
 * - tier：unit（临时目录，git 由 fake 执行器模拟；真实 git 的行为见 sources-fetch-url.git-integration.test.ts）。
 */
describe('MarketSourceManager source identity', () => {
  function identityManager(root: string, gitExecutor?: GitExecutor) {
    return new MarketSourceManager({
      store: new MarketSourceStore(path.join(root, 'sources.v1.json')),
      cloneRoot: path.join(root, 'sources'),
      homeDir: root,
      sourceIdOf: createMarketSourceIdOf(path.join(root, 'plugin-market', 'source-id.key')),
      ...(gitExecutor ? { gitExecutor } : {}),
    });
  }

  /**
   * git 的 fake：clone 写出市场与 .git 目录；`ls-remote --get-url` 按 resolve(cwd) 当下的返回模拟 insteadOf
   * （cwd 有值即在某个仓库的上下文里解析，可模拟只对缓存仓库生效的 includeIf）；`rev-parse` 默认 HEAD 与
   * 获取目标一致，upstream() 可让上游停在别处。
   */
  function rewritingGit(resolve: (cwd?: string, calls?: string[][]) => string | null, upstream: () => string = () => 'abc123') {
    const calls: string[][] = [];
    const executor: GitExecutor = async (args, options) => {
      calls.push([...args]);
      if (args[0] === '--version') return { stdout: 'git version 2.43.0\n', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(args[args.length - 1]);
        writeMarketplace(dest, 'hub', [{ rel: 'p', id: 'alpha' }]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'ls-remote') {
        const url = resolve(options.cwd, calls);
        if (url === null) throw new Error('fatal: could not read https://ghp_SECRET@github.com/acme/plugins.git');
        return { stdout: `${url}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `${String(args[args.length - 1]).startsWith('@{u}') ? upstream() : 'abc123'}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { executor, calls, clones: () => calls.filter((call) => call[0] === 'clone').length };
  }
  const SOURCE_ID = /^[A-Za-z0-9_-]{22}$/;

  it('gives two local folders different source ids and keeps them stable', async () => {
    const root = makeRoot();
    writeMarketplace(path.join(root, 'a'), 'lib-a', [{ rel: 'p', id: 'alpha' }]);
    writeMarketplace(path.join(root, 'b'), 'lib-b', [{ rel: 'p', id: 'alpha' }]);
    const manager = identityManager(root);
    await manager.addSource({ source: path.join(root, 'a') });
    await manager.addSource({ source: path.join(root, 'b') });
    const a = (await manager.discoverSource('lib-a')).sourceIdentity;
    const b = (await manager.discoverSource('lib-b')).sourceIdentity;
    expect(a).toEqual({ kind: 'local', sourceId: expect.stringMatching(SOURCE_ID) });
    expect(b?.sourceId).not.toBe(a?.sourceId);
    expect(JSON.stringify([a, b])).not.toContain(root);
    // A new manager (a later operation or a restart) reads the same key and yields the same ids.
    expect((await identityManager(root).discoverSource('lib-a')).sourceIdentity).toEqual(a);
  });

  it('gives two ports of one host different source ids', () => {
    const root = makeRoot();
    const sourceIdOf = createMarketSourceIdOf(path.join(root, 'source-id.key'));
    const sourceKey = marketSourceKey({ type: 'git', url: 'https://git.example.test/acme/plugins.git', sparsePaths: [] });
    const at = (port: number) => sourceIdOf({ kind: 'git', sourceKey,
      address: pluginMarketFetchAddress(`https://git.example.test:${port}/acme/plugins.git`)! });
    expect(at(8443)).toMatch(SOURCE_ID);
    expect(at(8443)).not.toBe(at(9443));
  });

  // PR #12731 maintainer review (06:33, item 1): on a plain SSH server the same host and relative path
  // resolve per login user, so the user is part of the source (only inside the local HMAC input).
  it('gives the same relative scp path under two SSH users different source ids', () => {
    const root = makeRoot();
    const sourceIdOf = createMarketSourceIdOf(path.join(root, 'source-id.key'));
    const sourceKey = marketSourceKey({ type: 'git', url: 'https://origin.example.test/acme/plugins.git', sparsePaths: [] });
    const as = (url: string) => sourceIdOf({ kind: 'git', sourceKey, address: pluginMarketFetchAddress(url)! });
    expect(as('alice@git.example.test:plugins.git')).toMatch(SOURCE_ID);
    expect(as('alice@git.example.test:plugins.git')).not.toBe(as('bob@git.example.test:plugins.git'));
    expect(as('ssh://alice@git.example.test/srv/plugins.git')).not.toBe(as('ssh://bob@git.example.test/srv/plugins.git'));
    // HTTPS credentials are not identity: rotating them keeps the same id.
    expect(as('https://ghp_ONE@git.example.test/acme/plugins.git')).toBe(as('https://ghp_TWO@git.example.test/acme/plugins.git'));
  });

  it('keeps an SSH login user out of the fetch record and the identity', async () => {
    const root = makeRoot();
    const manager = identityManager(root, rewritingGit(() => 'alice@git.example.test:acme/plugins.git').executor);
    await manager.addSource({ source: 'https://origin.example.test/acme/plugins.git' });
    const { sourceIdentity } = await manager.discoverSource('hub');
    expect(sourceIdentity).toMatchObject({ kind: 'git', repository: 'git.example.test/acme/plugins' });
    const records = fs.readdirSync(path.join(root, 'sources'), { recursive: true })
      .map(String).filter((file) => file.endsWith('cindy-fetch-identity.json'))
      .map((file) => fs.readFileSync(path.join(root, 'sources', file), 'utf8'));
    expect(records).toHaveLength(1);
    expect(`${JSON.stringify(sourceIdentity)}${records.join('')}`).not.toContain('alice');
  });

  it('keeps the key on this computer and rebuilds it only when missing or damaged', () => {
    const root = makeRoot();
    const keyPath = path.join(root, 'plugin-market', 'source-id.key');
    const key = marketSourceKey({ type: 'local', path: path.join(root, 'a') });
    const first = createMarketSourceIdOf(keyPath)({ kind: 'local', sourceKey: key });
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    // Lost or damaged key: a new one is written and read back; old ids no longer match (controllers stay
    // "unconfirmed"), and the rebuilt key is stable for later operations.
    fs.rmSync(keyPath);
    const second = createMarketSourceIdOf(keyPath)({ kind: 'local', sourceKey: key });
    expect(second).toMatch(SOURCE_ID);
    expect(second).not.toBe(first);
    fs.writeFileSync(keyPath, 'damaged');
    const third = createMarketSourceIdOf(keyPath)({ kind: 'local', sourceKey: key });
    expect(third).toMatch(SOURCE_ID);
    expect(third).not.toBe(second);
    expect(createMarketSourceIdOf(keyPath)({ kind: 'local', sourceKey: key })).toBe(third);
    // A key that exists but cannot be read is left alone: no ids this time.
    const lockedPath = path.join(root, 'locked', 'source-id.key');
    fs.mkdirSync(lockedPath, { recursive: true });
    expect(createMarketSourceIdOf(lockedPath)({ kind: 'local', sourceKey: key })).toBeNull();
    expect(fs.statSync(lockedPath).isDirectory()).toBe(true);
  });

  it('binds the source id to the actual fetch address: a rewrite to another repository changes it', async () => {
    const root = makeRoot();
    let target = 'https://mirror-a.example.test/tenant/plugins.git';
    const git = rewritingGit(() => target);
    const manager = identityManager(root, git.executor);
    await manager.addSource({ source: 'https://origin.example.test/acme/plugins.git' });
    const a = await manager.discoverSource('hub');
    expect(a.sourceIdentity).toEqual({ kind: 'git', repository: 'mirror-a.example.test/tenant/plugins', sourceId: expect.stringMatching(SOURCE_ID) });
    // Same configuration, the insteadOf target now points at another repository.
    target = 'https://mirror-b.example.test/tenant/plugins.git';
    await manager.refreshSource('hub');
    const b = await manager.discoverSource('hub');
    expect(b.sourceIdentity).toMatchObject({ repository: 'mirror-b.example.test/tenant/plugins' });
    expect(b.sourceId).not.toBe(a.sourceId);
    // The refresh did not fast-forward B on top of A's history: it cloned afresh.
    expect(git.clones()).toBe(2);
  });

  it('keeps the source id when only the credentials injected by a rewrite change', async () => {
    const root = makeRoot();
    let token = 'ghp_SECRET_ONE';
    const git = rewritingGit(() => `https://${token}@github.com/acme/plugins.git`);
    const manager = identityManager(root, git.executor);
    await manager.addSource({ source: 'acme/plugins' });
    const first = await manager.discoverSource('hub');
    token = 'ghp_SECRET_TWO';
    await manager.refreshSource('hub');
    const second = await manager.discoverSource('hub');
    expect(second.sourceIdentity).toEqual(first.sourceIdentity);
    expect(first.sourceIdentity).toMatchObject({ kind: 'git', repository: 'github.com/acme/plugins' });
    const records = fs.readdirSync(path.join(root, 'sources'), { recursive: true })
      .map(String).filter((file) => file.endsWith('cindy-fetch-identity.json'))
      .map((file) => fs.readFileSync(path.join(root, 'sources', file), 'utf8'));
    expect(records.length).toBeGreaterThan(0);
    expect(`${JSON.stringify([first, second])}${records.join('')}`).not.toMatch(/SECRET|ghp_/);
  });

  it('collects the fetch address in the repository git fetches in, not only the global context', async () => {
    const root = makeRoot();
    // An includeIf "gitdir:…" rule that only applies inside the cache repository rewrites to a mirror.
    const git = rewritingGit((cwd) => cwd ? 'https://mirror.example.test/tenant/plugins.git' : 'https://origin.example.test/acme/plugins.git');
    const manager = identityManager(root, git.executor);
    await manager.addSource({ source: 'https://origin.example.test/acme/plugins.git' });
    // The two contexts disagree, so neither the configured nor the mirrored address is claimed.
    expect((await manager.discoverSource('hub')).sourceIdentity).toBeNull();
    expect(git.calls.some((call) => call[0] === 'ls-remote')).toBe(true);
  });

  it('collects the address while the clone is still on its initial branch, not only after detaching', async () => {
    const root = makeRoot();
    // An includeIf "onbranch:main" rule rewrites to a mirror only while the fresh clone is on main; a pinned
    // ref then detaches HEAD and the rule no longer applies (Codex review on PR #12731).
    const git = rewritingGit((cwd, calls) => cwd && !calls?.some((call) => call[0] === 'checkout' && call.includes('--detach'))
      ? 'https://mirror.example.test/tenant/plugins.git'
      : 'https://origin.example.test/acme/plugins.git');
    const manager = identityManager(root, git.executor);
    await manager.addSource({ source: 'https://origin.example.test/acme/plugins.git', ref: 'v1.0.0' });
    expect((await manager.discoverSource('hub')).sourceIdentity).toBeNull();
  });

  it('leaves the identity unverified when the fetch address changes around the clone', async () => {
    const root = makeRoot();
    let calls = 0;
    const git = rewritingGit(() =>
      (calls += 1) === 1 ? 'https://github.com/acme/plugins.git' : 'https://mirror.example.test/tenant/plugins.git');
    const flipping = identityManager(root, git.executor);
    await flipping.addSource({ source: 'acme/plugins' });
    expect((await flipping.discoverSource('hub')).sourceIdentity).toBeNull();
  });

  it('never records a fast-forward whose HEAD is not the fetched target', async () => {
    const root = makeRoot();
    let upstreamAt = 'abc123';
    const git = rewritingGit(() => 'https://github.com/acme/plugins.git', () => upstreamAt);
    const manager = identityManager(root, git.executor);
    await manager.addSource({ source: 'acme/plugins' });
    expect(git.clones()).toBe(1);
    // The upstream now sits on an ancestor of the cached HEAD: pull --ff-only would "succeed" and keep the
    // newer local commit, so the refresh must clone afresh instead of recording that HEAD.
    upstreamAt = 'ancestor';
    await expect(manager.refreshSource('hub')).resolves.toMatchObject({ status: 'ok' });
    expect(git.clones()).toBe(2);
  });

  it('never lets a refreshed version inherit the previous fetch record', async () => {
    const root = makeRoot();
    let resolved: string | null = 'https://github.com/acme/plugins.git';
    const manager = identityManager(root, rewritingGit(() => resolved).executor);
    await manager.addSource({ source: 'acme/plugins' });
    expect((await manager.discoverSource('hub')).sourceIdentity).toMatchObject({ repository: 'github.com/acme/plugins' });
    // A refresh copies the current version first; when resolution now fails, the copied record must go.
    resolved = null;
    await manager.refreshSource('hub');
    expect((await manager.discoverSource('hub')).sourceIdentity).toBeNull();
    resolved = 'https://mirror.example.test/tenant/plugins.git';
    await manager.refreshSource('hub');
    expect((await manager.discoverSource('hub')).sourceIdentity).toMatchObject({ repository: 'mirror.example.test/tenant/plugins' });
  });

  it('keeps a failed address resolution, which may echo an injected token, out of the logs', async () => {
    const root = makeRoot();
    logged.splice(0);
    const manager = identityManager(root, rewritingGit(() => null).executor);
    await manager.addSource({ source: 'acme/plugins' });
    await manager.refreshSource('hub');
    expect((await manager.discoverSource('hub')).sourceIdentity).toBeNull();
    expect(JSON.stringify(logged)).not.toMatch(/SECRET|ghp_/);
  });
});
