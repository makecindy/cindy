/**
 * 自定义市场源管理器：添加 / 移除 / 刷新 / 发现的统一入口。
 *
 * 实例按 owner 构造（store 与 cloneRoot 已由调用方绑定到操作开始时的
 * dataOwner），与 PluginMarketService 的 ledger 同一套 owner 捕获语义。
 *
 * Git 缓存布局（版本目录 + 当前指针）：
 * - 每次刷新克隆/快进到 sources/<slug>/versions/<new>/ 并完成完整发现验证,
 *   验证通过后用可回滚原子写把 sources/<slug>/current 指针文件改成新版本名,
 *   再删旧版本目录。读取方永远经 current 指针解析到完整版本目录。
 * - 没有任何"固定路径被 rename"的瞬态:要么指针指向旧版(刷新中途失败,
 *   旧版完好),要么指向新版(全成功)。原子性由指针文件原子写保证,不需要
 *   备份交换/哨兵/自愈——并发读取与失败恢复从结构上就是安全的。
 * - 旧布局(单个 sources/<slug>/ 直接是缓存)在首次读取时自动迁移进版本目录。
 *
 * 不变量：
 * - Git 克隆目录是客户端管理的缓存，路径只由 (name, source) 派生，用户不应
 *   手动编辑。
 * - 市场名来自 marketplace.json，全局唯一；同名不同源拒绝添加。
 * - 移除来源只删配置与克隆缓存，已安装插件的包目录与 ledger 记录保留。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  MarketSource,
  MarketSourceConfig,
  MarketSourceSummary,
} from '../../../shared/pluginMarket.js';
import { createLogger } from '../../logger.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { atomicWriteFileSync } from '../../utils/atomicWriteFile.js';
import { discoverMarketplace, type DiscoveredMarketplace, type DiscoverError } from './discover.js';
import {
  MarketGitError,
  cloneMarketplace,
  fetchMarketplace,
  type GitExecutor,
} from './git.js';
import { checkGitPreflight as checkGitPreflightImpl } from './preflight.js';
import { parseMarketSource } from './parse.js';
import { MarketSourceStore } from './store.js';

export interface MarketSourceManagerDeps {
  store: MarketSourceStore;
  /** Git 克隆缓存根目录（owner 作用域）。 */
  cloneRoot: string;
  gitExecutor?: GitExecutor;
  homeDir?: string;
  now?: () => string;
}

export interface DiscoveredSource {
  config: MarketSourceConfig;
  result:
    | { ok: true; marketplace: DiscoveredMarketplace }
    | { ok: false; code: DiscoverError; detail?: string };
}

/** 克隆目录名：可读的市场名片段 + 来源指纹，避免同名不同源互相覆盖。 */
export function marketCloneSlug(name: string, source: MarketSource): string {
  const key =
    source.type === 'local'
      ? `local:${source.path}`
      : `git:${source.url}#${source.ref ?? ''}:${source.sparsePaths.join(',')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'market';
  return `${base}-${hash}`;
}

export class MarketSourceManager {
  private readonly log = createLogger('plugin-market-sources');

  constructor(private readonly deps: MarketSourceManagerDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /** 来源的缓存槽根目录（内含 versions/ 与 current 指针）。 */
  private cacheSlot(config: Pick<MarketSourceConfig, 'name' | 'source'>): string {
    return path.join(this.deps.cloneRoot, marketCloneSlug(config.name, config.source));
  }

  private versionsDir(slot: string): string {
    return path.join(slot, 'versions');
  }

  private currentPointer(slot: string): string {
    return path.join(slot, 'current');
  }

  /**
   * 解析 Git 源当前生效的缓存版本目录。读取 current 指针得到版本名,
   * 校验其在 versions/ 内(防指针被改成穿越路径);旧布局(槽目录直接是
   * 缓存,含 marketplace.json)首次读取时迁移进 versions/ 并写指针。
   * 无法解析(指针缺失/失效且非旧布局)返回 null。
   */
  private async resolveCurrentVersion(
    config: Pick<MarketSourceConfig, 'name' | 'source'>,
  ): Promise<string | null> {
    const slot = this.cacheSlot(config);
    const pointer = this.currentPointer(slot);
    // 已有指针:按指针解析。
    if (fs.existsSync(pointer)) {
      try {
        const version = (await fs.promises.readFile(pointer, 'utf8')).trim();
        // 版本名必须是 versions/ 下的直接子目录名,拒绝绝对路径与穿越。
        if (version && !version.includes('/') && !version.includes('\\') && version !== '..' && version !== '.') {
          const dir = path.join(this.versionsDir(slot), version);
          if (fs.existsSync(dir)) return dir;
        }
        this.log.warn('marketplace cache pointer invalid', { name: config.name, version });
        return null;
      } catch (error) {
        this.log.error('failed to read marketplace cache pointer', {
          name: config.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    // 旧布局迁移:槽目录直接是缓存(含 .agents 或 marketplace.json)。
    if (this.looksLikeLegacyCache(slot)) {
      const version = `legacy-${crypto.randomUUID()}`;
      const dir = path.join(this.versionsDir(slot), version);
      try {
        // 目标版本目录必须先存在,逐项搬入才不会因父目录缺失报 ENOENT。
        await fs.promises.mkdir(dir, { recursive: true });
        // 把槽目录里除 versions/current 外的内容整体搬进版本目录。
        const keep = new Set(['versions', 'current']);
        for (const entry of await fs.promises.readdir(slot)) {
          if (keep.has(entry)) continue;
          await fs.promises.rename(path.join(slot, entry), path.join(dir, entry));
        }
        atomicWriteFileSync(pointer, version);
        this.log.warn('migrated legacy marketplace cache layout', { name: config.name });
        return dir;
      } catch (error) {
        this.log.error('failed to migrate legacy marketplace cache', {
          name: config.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    return null;
  }

  /** 旧布局判定:槽目录本身含市场内容(.agents 目录)。 */
  private looksLikeLegacyCache(slot: string): boolean {
    if (!fs.existsSync(slot)) return false;
    try {
      return fs.statSync(slot).isDirectory() && fs.existsSync(path.join(slot, '.agents'));
    } catch {
      return false;
    }
  }

  /**
   * 刷新后让新版本生效:只做一件事——原子写 current 指针指向新版本目录。
   * 不删旧版本:读取方(listSources/snapshot/安装)可能正解析或使用旧版本,
   * 主动删除会在"解析→使用"窗口把在读者抽走。旧版本统一由下次刷新的
   * 延迟清理处理,读取路径因此零并发保护——指针原子切换即可保证:
   * 切换前解析到旧版→旧版还在;切换后解析到新版→新版完整。
   */
  private async activateVersion(slot: string, newVersion: string): Promise<void> {
    atomicWriteFileSync(this.currentPointer(slot), newVersion);
  }

  /**
   * 延迟清理历史版本:删除 versions/ 里非 current 的目录。只在刷新成功
   * 切换指针后调用,此刻被清理的是上上一轮的旧版本,任何当时的读取/
   * 安装/打包早已结束,不会抽到在读者。清理失败仅影响磁盘,不影响正确性。
   */
  private async pruneStaleVersions(slot: string): Promise<void> {
    const pointer = this.currentPointer(slot);
    if (!fs.existsSync(pointer)) return;
    let current: string;
    try {
      current = (await fs.promises.readFile(pointer, 'utf8')).trim();
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.versionsDir(slot));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === current) continue;
      // 仅删除 versions/ 内的直接子目录,防穿越。
      if (entry.includes('/') || entry.includes('\\') || entry === '..' || entry === '.') continue;
      await fs.promises
        .rm(path.join(this.versionsDir(slot), entry), { recursive: true, force: true })
        .catch((error: unknown) => {
          this.log.warn('failed to prune stale marketplace cache version', {
            version: entry,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  async addSource(input: {
    source: string;
    ref?: string;
    sparsePaths?: string[];
  }): Promise<MarketSourceSummary> {
    const parsed = parseMarketSource(input, this.deps.homeDir ?? os.homedir());
    if (!parsed.ok) {
      throwIpcError('MARKET_SOURCE_INVALID', parsed.code);
    }
    const source = parsed.source;

    if (this.deps.store.hasEquivalent(source)) {
      throwIpcError('ALREADY_EXISTS', 'This marketplace source has already been added');
    }

    if (source.type === 'local') {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(source.path);
      } catch {
        throwIpcError('MARKET_SOURCE_INVALID', 'LOCAL_SOURCE_NOT_DIRECTORY');
      }
      if (!stat!.isDirectory()) {
        throwIpcError('MARKET_SOURCE_INVALID', 'LOCAL_SOURCE_NOT_DIRECTORY');
      }
      return this.commitDiscoveredSource(source, source.path, null);
    }

    // Git 源：前置检测 → 克隆到独立目录 → 发现验证 → 激活为新版本。
    const preflight = await checkGitPreflightImpl(this.deps.gitExecutor);
    if (!preflight.ok) {
      throwIpcError('MARKET_GIT_UNAVAILABLE', preflight.version ?? 'git not found');
    }
    const incoming = path.join(this.deps.cloneRoot, `.incoming-${crypto.randomUUID()}`);
    let revision: string;
    try {
      revision = await cloneMarketplace(
        { url: source.url, ...(source.ref ? { ref: source.ref } : {}), sparsePaths: source.sparsePaths },
        incoming,
        this.deps.gitExecutor,
      );
    } catch (error) {
      if (error instanceof MarketGitError) {
        // 原始 git 输出（含命令行与内部路径）只进 main 日志；Renderer 拿到的是
        // 消毒后的 detail。IpcError 不经 invokePluginMarket 的兜底日志，这里必须留痕。
        this.log.warn('marketplace clone failed', { code: error.code, detail: error.message });
        throwIpcError(error.code, error.message);
      }
      throw error;
    }
    try {
      return await this.commitDiscoveredSource(source, incoming, revision);
    } catch (error) {
      await fs.promises.rm(incoming, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 发现 + 校验 + 落盘。Git 源的 discoveredRoot 先落在独立目录,持久化成功后
   * 整体搬入版本目录并激活(写 current 指针);名称冲突等失败由调用方清理。
   */
  private async commitDiscoveredSource(
    source: MarketSource,
    discoveredRoot: string,
    revision: string | null,
  ): Promise<MarketSourceSummary> {
    const discovered = await discoverMarketplace(discoveredRoot);
    if (!discovered.ok) {
      throwIpcError(discovered.code, discovered.detail ?? discovered.code);
    }
    const name = discovered.marketplace.name;
    if (this.deps.store.get(name)) {
      throwIpcError('ALREADY_EXISTS', `A marketplace named "${name}" has already been added`);
    }
    const config: MarketSourceConfig = {
      name,
      addedAt: this.now(),
      lastSyncedAt: this.now(),
      lastRevision: revision,
      source,
    };
    if (source.type === 'git') {
      const slot = this.cacheSlot(config);
      const version = crypto.randomUUID();
      const dir = path.join(this.versionsDir(slot), version);
      await fs.promises.rm(slot, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.mkdir(this.versionsDir(slot), { recursive: true });
      await fs.promises.rename(discoveredRoot, dir);
      atomicWriteFileSync(this.currentPointer(slot), version);
    }
    this.deps.store.add(config);
    return this.toSummary(config, discovered.marketplace);
  }

  async removeSource(name: string): Promise<{ ok: true }> {
    const removed = this.deps.store.remove(name);
    if (!removed) {
      throwIpcError('NOT_FOUND', 'The marketplace source is not added');
    }
    if (removed.source.type === 'git') {
      await fs.promises
        .rm(this.cacheSlot(removed), { recursive: true, force: true })
        .catch(() => undefined);
    }
    return { ok: true };
  }

  async refreshSource(name: string): Promise<MarketSourceSummary> {
    const config = this.deps.store.get(name);
    if (!config) {
      throwIpcError('NOT_FOUND', 'The marketplace source is not added');
    }

    if (config.source.type === 'local') {
      if (!fs.existsSync(config.source.path)) {
        throwIpcError('MARKET_SOURCE_INVALID', 'LOCAL_SOURCE_NOT_DIRECTORY');
      }
      const discovered = await discoverMarketplace(config.source.path);
      if (!discovered.ok) {
        throwIpcError(discovered.code, discovered.detail ?? discovered.code);
      }
      const syncedAt = this.now();
      this.deps.store.update(name, { lastSyncedAt: syncedAt });
      return this.toSummary({ ...config, lastSyncedAt: syncedAt }, discovered.marketplace);
    }

    const preflight = await checkGitPreflightImpl(this.deps.gitExecutor);
    if (!preflight.ok) {
      throwIpcError('MARKET_GIT_UNAVAILABLE', preflight.version ?? 'git not found');
    }
    const slot = this.cacheSlot(config);
    const gitSource = config.source;
    const current = await this.resolveCurrentVersion(config);
    // 新版本目录:快进或重克隆都在这里完成,验证通过才激活,不碰当前版本。
    const newVersion = crypto.randomUUID();
    const newDir = path.join(this.versionsDir(slot), newVersion);
    await fs.promises.mkdir(this.versionsDir(slot), { recursive: true });
    // 两条路径(快进成功 / 重克隆)都会赋值或抛出,此处仅满足 TS 的确定性赋值分析。
    let revision = '';
    let discovered: Extract<
      Awaited<ReturnType<typeof discoverMarketplace>>,
      { ok: true }
    >;
    try {
      let fastForwarded = false;
      if (current) {
        // 快进路径:复制当前版本到新目录,在新目录内快进。
        try {
          await fs.promises.cp(current, newDir, { recursive: true });
          revision = await fetchMarketplace(current, gitSource.ref, this.deps.gitExecutor, newDir);
          fastForwarded = true;
        } catch {
          fastForwarded = false;
          await fs.promises.rm(newDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (!fastForwarded) {
        // 无当前版本或快进失败(历史改写/缓存损坏):整目录重克隆到新目录。
        try {
          revision = await cloneMarketplace(
            {
              url: gitSource.url,
              ...(gitSource.ref ? { ref: gitSource.ref } : {}),
              sparsePaths: gitSource.sparsePaths,
            },
            newDir,
            this.deps.gitExecutor,
          );
        } catch (error) {
          if (error instanceof MarketGitError) throwIpcError(error.code, error.message);
          throw error;
        }
      }
      // 在新版本目录完成完整发现验证,通过后才激活;失败删新目录,当前版本不动。
      const staged = await discoverMarketplace(newDir);
      if (!staged.ok) {
        throwIpcError(staged.code, staged.detail ?? staged.code);
      }
      discovered = staged;
    } catch (error) {
      await fs.promises.rm(newDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await this.activateVersion(slot, newVersion);
    // 指针已切到新版本,延迟清理上上一轮的旧版本(此刻无任何在读者)。
    await this.pruneStaleVersions(slot);
    const syncedAt = this.now();
    this.deps.store.update(name, { lastSyncedAt: syncedAt, lastRevision: revision });
    return this.toSummary(
      { ...config, lastSyncedAt: syncedAt, lastRevision: revision },
      discovered.marketplace,
    );
  }

  getConfig(name: string): MarketSourceConfig | null {
    return this.deps.store.get(name);
  }

  /** 发现单个来源（详情 / 安装入口现查事实用）。 */
  async discoverSource(name: string): Promise<DiscoveredSource> {
    const config = this.deps.store.get(name);
    if (!config) {
      throwIpcError('NOT_FOUND', 'The marketplace source is not added');
    }
    const root = await this.marketRoot(config!);
    if (!root || !fs.existsSync(root)) {
      return {
        config: config!,
        result: { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'market root missing' },
      };
    }
    const discovered = await discoverMarketplace(root);
    return {
      config: config!,
      result: discovered.ok
        ? { ok: true, marketplace: discovered.marketplace }
        : { ok: false, code: discovered.code, ...(discovered.detail ? { detail: discovered.detail } : {}) },
    };
  }

  /** 管理视图用：全部来源 + 实时发现状态。单个源失败不影响其它源。 */
  async listSources(): Promise<MarketSourceSummary[]> {
    const discovered = await this.discoverAll();
    return discovered.map((entry) =>
      entry.result.ok
        ? this.toSummary(entry.config, entry.result.marketplace)
        : {
            ...entry.config,
            pluginCount: 0,
            status: 'error' as const,
            errorCode: entry.result.code,
          },
    );
  }

  /** 快照聚合用：全部来源的发现结果（含失败）。 */
  async discoverAll(): Promise<DiscoveredSource[]> {
    const configs = this.deps.store.list();
    const results: DiscoveredSource[] = [];
    for (const config of configs) {
      const root = await this.marketRoot(config);
      if (!root || !fs.existsSync(root)) {
        results.push({
          config,
          result: { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'market root missing' },
        });
        continue;
      }
      const discovered = await discoverMarketplace(root);
      results.push({
        config,
        result: discovered.ok
          ? { ok: true, marketplace: discovered.marketplace }
          : { ok: false, code: discovered.code, ...(discovered.detail ? { detail: discovered.detail } : {}) },
      });
    }
    return results;
  }

  /** 来源的市场根目录：Git 源指向当前缓存版本目录，本地源指向用户目录。 */
  private async marketRoot(config: MarketSourceConfig): Promise<string | null> {
    if (config.source.type === 'local') return config.source.path;
    return this.resolveCurrentVersion(config);
  }

  private toSummary(
    config: MarketSourceConfig,
    marketplace: DiscoveredMarketplace,
  ): MarketSourceSummary {
    return {
      ...config,
      pluginCount: marketplace.plugins.length,
      status: 'ok',
      errorCode: null,
    };
  }
}
