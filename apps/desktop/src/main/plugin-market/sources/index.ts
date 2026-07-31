/**
 * 自定义市场源管理器：添加 / 移除 / 刷新 / 发现的统一入口。
 *
 * 实例按 owner 构造（store 与 cloneRoot 已由调用方绑定到操作开始时的
 * dataOwner），与 PluginMarketService 的 ledger 同一套 owner 捕获语义。
 *
 * 不变量：
 * - Git 克隆目录是客户端管理的缓存，路径只由 (name, source) 派生，用户不应
 *   手动编辑；刷新失败时整目录重克隆 + 原子替换，不留半拉子状态。
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
import { throwIpcError } from '../../utils/ipcValidate.js';
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
  constructor(private readonly deps: MarketSourceManagerDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private cloneDir(config: Pick<MarketSourceConfig, 'name' | 'source'>): string {
    return path.join(this.deps.cloneRoot, marketCloneSlug(config.name, config.source));
  }

  /** 来源的市场根目录：Git 源指向克隆缓存，本地源指向用户目录。 */
  private marketRoot(config: MarketSourceConfig): string {
    return config.source.type === 'local' ? config.source.path : this.cloneDir(config);
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

    // Git 源：前置检测 → 克隆到临时目录 → 发现 → 更名进正式缓存目录。
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
      if (error instanceof MarketGitError) throwIpcError(error.code, error.message);
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
   * 发现 + 校验 + 落盘。Git 源的 discoveredRoot 先落在临时目录，持久化成功后
   * 才更名为正式克隆目录（按 slug 派生）；名称冲突等失败由调用方清理临时目录。
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
      const finalDir = this.cloneDir(config);
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.rename(discoveredRoot, finalDir);
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
        .rm(this.cloneDir(removed), { recursive: true, force: true })
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
      this.deps.store.update(name, { lastSyncedAt: this.now() });
      return this.toSummary({ ...config, lastSyncedAt: this.now() }, discovered.marketplace);
    }

    const preflight = await checkGitPreflightImpl(this.deps.gitExecutor);
    if (!preflight.ok) {
      throwIpcError('MARKET_GIT_UNAVAILABLE', preflight.version ?? 'git not found');
    }
    const cloneDir = this.cloneDir(config);
    const gitSource = config.source;
    let revision: string;
    try {
      revision = await fetchMarketplace(cloneDir, gitSource.ref, this.deps.gitExecutor);
    } catch {
      // 快进失败（历史改写 / 缓存损坏）：整目录重克隆 + 原子替换。
      const staging = `${cloneDir}.restage-${crypto.randomUUID()}`;
      try {
        revision = await cloneMarketplace(
          {
            url: gitSource.url,
            ...(gitSource.ref ? { ref: gitSource.ref } : {}),
            sparsePaths: gitSource.sparsePaths,
          },
          staging,
          this.deps.gitExecutor,
        );
      } catch (error) {
        if (error instanceof MarketGitError) throwIpcError(error.code, error.message);
        throw error;
      }
      await fs.promises.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.rename(staging, cloneDir);
    }
    const discovered = await discoverMarketplace(cloneDir);
    if (!discovered.ok) {
      throwIpcError(discovered.code, discovered.detail ?? discovered.code);
    }
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
    const root = this.marketRoot(config!);
    if (!fs.existsSync(root)) {
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
      const root = this.marketRoot(config);
      if (!fs.existsSync(root)) {
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
