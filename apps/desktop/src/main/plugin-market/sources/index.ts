/**
 * 自定义市场源管理器：添加 / 移除 / 刷新 / 发现的统一入口。
 *
 * 实例按 owner 构造（store 与 cloneRoot 已由调用方绑定到操作开始时的
 * dataOwner），与 PluginMarketService 的 ledger 同一套 owner 捕获语义。
 *
 * Git 缓存布局（版本目录 + 当前指针 + 读取引用计数）：
 * - 每次刷新克隆/快进到 sources/<slug>/incoming/<uuid>/ 并完成完整发现验证,
 *   通过后才 rename 进 sources/<slug>/versions/<new>/,再用可回滚原子写把
 *   sources/<slug>/current 指针文件改成新版本名。读取方永远经 current 指针
 *   解析到完整版本目录。
 * - 在途工作一律在 versions/ 之外:git clone 会在目标同级建 `<dest>.staging-*`,
 *   目标若在 versions/ 内,并发刷新切完指针后的清理会把别人正在写的 staging
 *   目录当历史版本删掉。versions/ 只承载完整版本目录,清理碰不到在途工作。
 * - 没有任何"固定路径被 rename"的瞬态:要么指针指向旧版(刷新中途失败,
 *   旧版完好),要么指向新版(全成功)。原子性由指针文件原子写保证,不需要
 *   备份交换/哨兵/自愈。
 * - 旧版本目录的清理受**进程内引用计数**保护:清理只删引用数为 0 的版本,
 *   仍被引用的进 pendingDeletes,等最后一个引用释放时才删。缺了这层,刷新在
 *   切完指针后立即删非 current 版本,会把"已解析到旧版目录、正在异步发现或
 *   逐文件打包安装"的读取方从中途抽走(安装随机失败/输入残缺)。
 * - 计数注册表是**模块级、按绝对路径为键**的(见下方 versionRefs):调用方每次
 *   操作都新建一个 manager,放实例字段会让安装持有的租约对刷新不可见。
 * - 引用登记的关键是**与指针解析同步完成**:resolveCurrentVersionSync 全同步,
 *   acquireCurrentVersion 在同一个同步块里解析并登记,中间不 await,因此不存在
 *   "解析到登记"的窗口——任何 fs 回调都插不进来。文件系统标记(.reading 之类)
 *   做不到这点(解析与落标记之间必有 await,且标记会被 fs.cp 复制进新版本)。
 * - 旧布局(单个 sources/<slug>/ 直接是缓存)在首次读取时自动迁移进版本目录。
 * - 前提:同一 userData 只有一个 main 进程管理这些缓存槽(Electron 单实例)。
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

/*
 * 缓存版本目录的读取引用注册表。**必须是模块级、按绝对路径为键**:
 * `PluginMarketService` 每次操作都新建一个 `MarketSourceManager`(store/cloneRoot
 * 按操作开始时的 owner 现绑),若把计数放实例字段,安装 manager 持有的租约对刷新
 * manager 完全不可见,刷新照样会删掉正在被打包读取的旧版本 —— 计数等于没做。
 *
 * 受保护的对象本来就是"文件系统路径",按路径为键才是正确的作用域;owner 隔离由
 * 路径自带(`ownerScopedUserDataPath` 已把 owner 编进 cloneRoot),不同 owner 的
 * 键天然不相交。仅 main 进程内有效(同一 userData 只有一个 main 进程,Electron
 * 单实例)。
 */

/** 正在被读取的版本目录 → 引用数。清理只删引用数为 0 的版本目录。 */
const versionRefs = new Map<string, number>();

/** 清理时仍被引用、推迟到最后一个引用释放后再删的版本目录。 */
const pendingDeletes = new Set<string>();

/**
 * 正在进行的刷新的暂存目录。清理按**前缀**放过它们:git clone 还会在同级建
 * `<incoming>.staging-<uuid>`,只比对完整路径会把那个在途目录删掉。
 */
const activeIncoming = new Set<string>();

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
   * 一次刷新的暂存目录,刻意放在 versions/ 之外:git clone 会在目标同级建
   * `<dest>.staging-<uuid>`,若目标位于 versions/ 内,并发刷新的清理会把这些
   * 在途目录当历史版本删掉。versions/ 只承载完整版本目录。
   */
  private incomingDir(slot: string): string {
    return path.join(slot, 'incoming', crypto.randomUUID());
  }

  /**
   * 解析 Git 源当前生效的缓存版本目录。读取 current 指针得到版本名,
   * 校验其在 versions/ 内(防指针被改成穿越路径);旧布局(槽目录直接是
   * 缓存,含 marketplace.json)首次读取时迁移进 versions/ 并写指针。
   * 无法解析(指针缺失/失效且非旧布局)返回 null。
   *
   * **必须保持全同步**:调用方要在同一个同步块里解析 + 登记引用(见
   * acquireCurrentVersion),中间出现 await 就会重新引入"解析到登记"的窗口。
   */
  private resolveCurrentVersionSync(
    config: Pick<MarketSourceConfig, 'name' | 'source'>,
  ): string | null {
    const slot = this.cacheSlot(config);
    const pointer = this.currentPointer(slot);
    // 已有指针:按指针解析。
    if (fs.existsSync(pointer)) {
      try {
        const version = fs.readFileSync(pointer, 'utf8').trim();
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
        fs.mkdirSync(dir, { recursive: true });
        // 把槽目录里除 versions/current/incoming 外的内容整体搬进版本目录。
        const keep = new Set(['versions', 'current', 'incoming']);
        for (const entry of fs.readdirSync(slot)) {
          if (keep.has(entry)) continue;
          fs.renameSync(path.join(slot, entry), path.join(dir, entry));
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

  /**
   * 解析当前版本目录并登记一个读取引用。**解析与登记之间没有 await**:
   * JS 单线程 run-to-completion 保证这段同步块执行期间不会有任何 fs 回调
   * (包括并发刷新的清理)插入,因此不存在"解析到旧目录、登记前被删"的窗口。
   */
  private acquireCurrentVersion(
    config: Pick<MarketSourceConfig, 'name' | 'source'>,
  ): string | null {
    const dir = this.resolveCurrentVersionSync(config);
    if (!dir) return null;
    this.retainVersion(dir);
    return dir;
  }

  /**
   * 登记一个已知版本目录的引用。除了读取,刷新把暂存目录 rename 进 versions/ 到
   * 切指针之间也要登记:那段时间新版本还不是 current,并发刷新的清理会把它当
   * 历史版本删掉。
   */
  private retainVersion(dir: string): void {
    versionRefs.set(dir, (versionRefs.get(dir) ?? 0) + 1);
  }

  /** 释放引用;最后一个引用释放时执行被推迟的清理。 */
  private releaseVersion(dir: string): void {
    const remaining = (versionRefs.get(dir) ?? 0) - 1;
    if (remaining > 0) {
      versionRefs.set(dir, remaining);
      return;
    }
    versionRefs.delete(dir);
    if (!pendingDeletes.delete(dir)) return;
    // 推迟期间该版本可能已经成为 current(并发刷新:A 的清理把 B 正在暂存的
    // 目录记为待删,随后 B 把指针切到它)。执行前重新核对,不删当前生效版本。
    if (this.isCurrentVersionDir(dir)) return;
    void this.removeVersionDir(dir);
  }

  /** 目录是否为其所属槽当前生效的版本(推迟清理执行前的再核对)。 */
  private isCurrentVersionDir(dir: string): boolean {
    // 版本目录布局固定为 <slot>/versions/<version>。
    const slot = path.dirname(path.dirname(dir));
    try {
      return fs.readFileSync(this.currentPointer(slot), 'utf8').trim() === path.basename(dir);
    } catch {
      return false;
    }
  }

  /**
   * 在持有版本目录读取引用的作用域内执行 fn。租约必须覆盖到目录的**最后一次
   * 使用**为止(例如自定义源安装要一直持到 .cindy 打包完成),否则并发刷新的
   * 清理仍能在使用途中把目录抽走。
   */
  private async withCurrentVersion<T>(
    config: Pick<MarketSourceConfig, 'name' | 'source'>,
    fn: (dir: string | null) => Promise<T>,
  ): Promise<T> {
    const dir = this.acquireCurrentVersion(config);
    if (!dir) return fn(null);
    try {
      return await fn(dir);
    } finally {
      this.releaseVersion(dir);
    }
  }

  /** 删除一个版本目录;失败仅影响磁盘占用,不影响正确性。 */
  private async removeVersionDir(dir: string): Promise<void> {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.log.warn('failed to prune stale marketplace cache version', {
        version: path.basename(dir),
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
   * 指针切换是唯一的生效动作:切换前解析到旧版→旧版还在(清理受引用保护),
   * 切换后解析到新版→新版已完成完整发现验证。
   */
  private async activateVersion(slot: string, newVersion: string): Promise<void> {
    atomicWriteFileSync(this.currentPointer(slot), newVersion);
  }

  /**
   * 清理历史版本:删除 versions/ 里非 current 且**当前无人读取**的目录。
   * 仍被引用的目录进 pendingDeletes,由最后一个引用释放时删除 —— 刚被切下来
   * 的那一代往往正被并发的发现/详情/安装打包使用,直接删会把它们从中途抽走。
   * 清理失败仅影响磁盘占用,不影响正确性。
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
      const dir = path.join(this.versionsDir(slot), entry);
      // 有读者:推迟到最后一个引用释放。释放路径同样会消费 pendingDeletes,
      // 因此目录不会被永久留下(引用在 finally 里释放)。
      if ((versionRefs.get(dir) ?? 0) > 0) {
        pendingDeletes.add(dir);
        continue;
      }
      await this.removeVersionDir(dir);
    }
    await this.pruneStaleIncoming(slot);
  }

  /**
   * 清理 incoming/ 里已死的暂存目录(进程在刷新途中被杀会留下残骸)。
   * 在途的按前缀放过:git clone 的 `<incoming>.staging-<uuid>` 也属于在途。
   * incoming/ 不会被任何读取方读取,不需要引用计数,只需避开在途集合。
   */
  private async pruneStaleIncoming(slot: string): Promise<void> {
    const root = path.join(slot, 'incoming');
    let entries: string[];
    try {
      entries = await fs.promises.readdir(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.includes('/') || entry.includes('\\') || entry === '..' || entry === '.') continue;
      const dir = path.join(root, entry);
      let inFlight = false;
      for (const active of activeIncoming) {
        if (dir === active || dir.startsWith(active)) {
          inFlight = true;
          break;
        }
      }
      if (inFlight) continue;
      await this.removeVersionDir(dir);
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
    const newVersion = crypto.randomUUID();
    const newDir = path.join(this.versionsDir(slot), newVersion);
    // 暂存目录必须落在 versions/ **之外**:cloneMarketplace 会在目标同级建
    // `<dest>.staging-<uuid>`,目标若在 versions/ 内,并发刷新切完指针后的清理
    // 会把别人正在写入的 staging 目录当历史版本删掉。versions/ 只放完整版本,
    // 清理就永远碰不到在途工作。
    const incoming = this.incomingDir(slot);
    // 在途登记:并发刷新的 incoming/ 清理据此按前缀放过本次的暂存与 staging 目录。
    activeIncoming.add(incoming);
    try {
      await fs.promises.mkdir(path.dirname(incoming), { recursive: true });
      await fs.promises.mkdir(this.versionsDir(slot), { recursive: true });
      // 快进要整目录复制当前版本并在其上 fetch:登记读取引用,否则并发刷新的
      // 清理能在复制途中删掉源目录。引用在快进段结束后立刻释放(见 finally)。
      const current = this.acquireCurrentVersion(config);
      // 两条路径(快进成功 / 重克隆)都会赋值或抛出,此处仅满足 TS 的确定性赋值分析。
      let revision = '';
      let discovered: Extract<
        Awaited<ReturnType<typeof discoverMarketplace>>,
        { ok: true }
      >;
      try {
        let fastForwarded = false;
        if (current) {
          // 快进路径:复制当前版本到暂存目录,在暂存目录内快进。
          try {
            await fs.promises.cp(current, incoming, { recursive: true });
            revision = await fetchMarketplace(current, gitSource.ref, this.deps.gitExecutor, incoming);
            fastForwarded = true;
          } catch {
            fastForwarded = false;
            await fs.promises.rm(incoming, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        if (!fastForwarded) {
          // 无当前版本或快进失败(历史改写/缓存损坏):整目录重克隆到暂存目录。
          try {
            revision = await cloneMarketplace(
              {
                url: gitSource.url,
                ...(gitSource.ref ? { ref: gitSource.ref } : {}),
                sparsePaths: gitSource.sparsePaths,
              },
              incoming,
              this.deps.gitExecutor,
            );
          } catch (error) {
            if (error instanceof MarketGitError) throwIpcError(error.code, error.message);
            throw error;
          }
        }
        // 在暂存目录完成完整发现验证,通过后才落位并激活;失败只删暂存目录,
        // 当前版本不动。
        const staged = await discoverMarketplace(incoming);
        if (!staged.ok) {
          throwIpcError(staged.code, staged.detail ?? staged.code);
        }
        discovered = staged;
      } catch (error) {
        await fs.promises.rm(incoming, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      } finally {
        // 快进段已结束(成功或回落重克隆),本次刷新不再使用旧版本目录。
        if (current) this.releaseVersion(current);
      }
      // 落位前先登记引用:rename 进 versions/ 到切指针之间,新版本还不是 current,
      // 并发刷新的清理会把它当历史版本删掉。
      this.retainVersion(newDir);
      try {
        // 落位与激活是唯一可回滚的一段:失败时指针可能仍指向旧版本,
        // 此时清掉暂存与半落位目录是安全的。
        try {
          await fs.promises.rename(incoming, newDir);
          await this.activateVersion(slot, newVersion);
        } catch (error) {
          await fs.promises.rm(incoming, { recursive: true, force: true }).catch(() => undefined);
          // 只有指针确实没有指向 newDir 时才删它。指针一旦生效,newDir 就是唯一
          // 有效缓存,删掉会留下"指针指向不存在目录"的槽,整个来源从列表消失。
          if (!this.isCurrentVersionDir(newDir)) {
            await fs.promises.rm(newDir, { recursive: true, force: true }).catch(() => undefined);
          }
          throw error;
        }
        // —— 到这里指针已生效:newDir 是当前唯一有效缓存,后续任何失败都不得删它 ——
        // 指针已切到新版本:清理非 current 版本,仍被读取的推迟到引用释放后再删。
        await this.pruneStaleVersions(slot);
        const syncedAt = this.now();
        try {
          this.deps.store.update(name, { lastSyncedAt: syncedAt, lastRevision: revision });
        } catch (error) {
          // 元数据写入失败(磁盘满/只读/文件锁)不影响缓存有效性:如实上报失败,
          // 但绝不回收已生效的版本目录——下次刷新会重写元数据。
          this.log.error('failed to persist marketplace sync metadata', {
            name,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        return this.toSummary(
          { ...config, lastSyncedAt: syncedAt, lastRevision: revision },
          discovered.marketplace,
        );
      } finally {
        this.releaseVersion(newDir);
      }
    } finally {
      activeIncoming.delete(incoming);
    }
  }

  getConfig(name: string): MarketSourceConfig | null {
    return this.deps.store.get(name);
  }

  /**
   * 发现单个来源（详情 / 安装入口现查事实用）。
   *
   * 发现结果里的 `plugin.dir` 指向缓存版本目录:调用方**在 fn 返回后就不得再
   * 使用这些路径**。要跨到后续读盘(例如安装打包)的调用方必须把那段工作放进
   * fn 内,租约才覆盖到最后一次使用;否则并发刷新的清理可以在中途删掉目录。
   */
  async withDiscoveredSource<T>(
    name: string,
    fn: (discovered: DiscoveredSource) => Promise<T>,
  ): Promise<T> {
    const config = this.deps.store.get(name);
    if (!config) {
      throwIpcError('NOT_FOUND', 'The marketplace source is not added');
    }
    return this.withMarketRoot(config!, async (root) => {
      if (!root || !fs.existsSync(root)) {
        return fn({
          config: config!,
          result: { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'market root missing' },
        });
      }
      const discovered = await discoverMarketplace(root);
      return fn({
        config: config!,
        result: discovered.ok
          ? { ok: true, marketplace: discovered.marketplace }
          : {
              ok: false,
              code: discovered.code,
              ...(discovered.detail ? { detail: discovered.detail } : {}),
            },
      });
    });
  }

  /**
   * 发现单个来源并返回结果。只读取发现出的元数据时用这个;结果里的
   * `plugin.dir` 在返回后已不受租约保护,需要继续读盘请改用
   * `withDiscoveredSource`。
   */
  async discoverSource(name: string): Promise<DiscoveredSource> {
    return this.withDiscoveredSource(name, async (discovered) => discovered);
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
      await this.withMarketRoot(config, async (root) => {
        if (!root || !fs.existsSync(root)) {
          results.push({
            config,
            result: { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'market root missing' },
          });
          return;
        }
        const discovered = await discoverMarketplace(root);
        results.push({
          config,
          result: discovered.ok
            ? { ok: true, marketplace: discovered.marketplace }
            : {
                ok: false,
                code: discovered.code,
                ...(discovered.detail ? { detail: discovered.detail } : {}),
              },
        });
      });
    }
    return results;
  }

  /**
   * 在持有读取引用的作用域内提供来源的市场根目录:Git 源是当前缓存版本目录
   * (受引用保护,fn 执行期间不会被清理删掉),本地源是用户目录(用户自管,
   * 客户端不清理,无需引用)。
   */
  private async withMarketRoot<T>(
    config: MarketSourceConfig,
    fn: (root: string | null) => Promise<T>,
  ): Promise<T> {
    if (config.source.type === 'local') return fn(config.source.path);
    return this.withCurrentVersion(config, fn);
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
