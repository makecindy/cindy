import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketSourceManager, marketCloneSlug } from '../sources/index';
import type { GitExecutor } from '../sources/git';
import { releaseCachePath, retainCachePath } from '../sources/cacheLease';
import { MarketSourceStore } from '../sources/store';

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
