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
 * - **本文件不直接删除任何缓存路径**:所有删除都经 `removeCacheDir` →
 *   `cacheLease.removeCachePath` 这一个入口,与持有中的租约重叠就自动推迟。
 *   这块此前反复出事,每轮都是"又发现一个删除点没查租约"(交换旧目录、清理历史
 *   版本、清理暂存目录、移除来源、失败回滚各自直接 rm)。收口到唯一入口后,
 *   "删掉正在被读的路径"才从结构上不可能发生,而不是靠每个调用点自觉。判据与
 *   推迟机制见 `cacheLease.ts`。
 * - 租约登记的关键是**与指针解析同步完成**:resolveCurrentVersionSync 全同步,
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

import {
  marketSourceKey,
  type MarketSource,
  type MarketSourceConfig,
  type MarketSourceSummary,
} from '../../../shared/pluginMarket.js';
import { createLogger } from '../../logger.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile.js';
import {
  releaseCachePath,
  removeCachePath,
  retainCachePath,
  settleCachePathRemovals,
} from './cacheLease.js';
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
  // 指纹定义与账本所有权校验共用 marketSourceKey,两处永不漂移。
  const hash = crypto
    .createHash('sha256')
    .update(marketSourceKey(source))
    .digest('hex')
    .slice(0, 10);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'market';
  return `${base}-${hash}`;
}

/**
 * Windows 上 AV / 索引器 / 云同步会短暂占用刚 clone / cp 出来的目录里的文件,
 * 使 rename 抛 EBUSY / EACCES / EPERM。这些是瞬时锁,短退避重试即可解除;目标
 * 都是全新 UUID 路径(不存在覆盖问题),重试纯粹是等锁释放。其余错误立即上抛。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const transient = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= 3 || !code || !transient.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** 版本目录名比较:大小写不敏感。我们生成的版本名恒为小写 UUID,但备份还原 /
 * 跨 FS 迁移可能引入大小写漂移;不敏感比较确保绝不把 current 的大小写变体
 * 误判成历史版本删掉(方向永远偏向"不删")。 */
function sameVersionName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
    // 已有指针:按指针解析。指针也是原子写维护的文件,备份交换连续失败时唯一有效
    // 的那份会留在 `current.bak` —— 只看主文件会把仍有完整版本的缓存判成缺失,
    // 整个来源报 market root missing。所以经 readAtomicFileSync 读,让它先恢复。
    if (fs.existsSync(pointer) || fs.existsSync(`${pointer}.bak`)) {
      try {
        const version = (readAtomicFileSync(pointer) ?? '').trim();
        // 版本名必须是 versions/ 下的直接子目录名,拒绝绝对路径与穿越。
        if (version && !version.includes('/') && !version.includes('\\') && version !== '..' && version !== '.') {
          const dir = path.join(this.versionsDir(slot), version);
          if (fs.existsSync(dir)) return dir;
        }
        this.log.warn('marketplace cache pointer invalid', { name: config.name, version });
        return null;
      } catch (error) {
        // 指针读不出来(含备份也恢复不了)按"无可用缓存"处理即可 —— 与 ledger /
        // 来源配置不同,缓存是可重建的:返回 null 会让下次刷新整目录重克隆,
        // 不存在"用空数据覆盖用户资产"的风险。
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
          // 符号链接条目不搬(与打包/读取侧同口径:一律不跟随)。留在旧槽根即可,
          // 读取只经 versions/ 目录,永不跟随它;删除留给缓存删除唯一入口,本文件
          // 不做任何直接的文件系统删除(结构门禁)。
          const src = path.join(slot, entry);
          if (fs.lstatSync(src).isSymbolicLink()) continue;
          fs.renameSync(src, path.join(dir, entry));
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
    retainCachePath(dir);
    return dir;
  }

  /**
   * 该缓存槽当前是否仍被某个已配置来源占用(整槽删除在执行前的再核对)。
   *
   * 整槽删除可能因租约被推迟。推迟期间用户完全可以移除后**立刻重新添加同名同源**
   * 的来源——槽路径只由 (name, source) 派生,于是同一个槽被复用、写入并激活了新
   * 版本。此时若不核对就执行那笔延迟删除,会把刚添加成功的缓存连 current 指针一起
   * 递归删掉,配置有效但市场内容不见了(报 MARKET_SOURCE_INVALID / market root
   * missing)。按"槽是否仍被配置占用"判定,同时覆盖两种情形:重新添加同源(同槽,
   * 放弃删除)与重新添加异源(异槽,旧槽照常回收)。
   */
  private slotIsConfigured(slot: string): boolean {
    try {
      return this.deps.store.list().some((config) => this.cacheSlot(config) === slot);
    } catch {
      // 读不到配置时按"仍被占用"处理:宁可漏回收磁盘,也不误删有效缓存。
      return true;
    }
  }

  /** 目录是否为其所属槽当前生效的版本(推迟清理执行前的再核对)。 */
  private isCurrentVersionDir(dir: string): boolean {
    // 版本目录布局固定为 <slot>/versions/<version>。
    const slot = path.dirname(path.dirname(dir));
    try {
      // 经 readAtomicFileSync:主文件缺失但 current.bak 是唯一有效指针时,
      // 裸读会把当前版本误判成"非 current",让延迟删除把它删掉。
      const text = readAtomicFileSync(this.currentPointer(slot));
      if (text === null) return false;
      return sameVersionName(text.trim(), path.basename(dir));
    } catch {
      // 指针读不出来(文件锁/备份救不回来):事实不明,宁可不删。
      return true;
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
      releaseCachePath(dir);
    }
  }

  /**
   * 删除一个缓存目录。所有缓存删除都必须走这里(它再走 `removeCachePath` 这个
   * 唯一入口):有租约重叠就自动推迟,调用点不需要、也不允许自己判断。
   */
  private async removeCacheDir(
    dir: string,
    options: { skipIf?: () => boolean } = {},
  ): Promise<void> {
    await removeCachePath(dir, {
      ...options,
      onError: (error: unknown) => {
        this.log.warn('failed to remove marketplace cache directory', {
          target: path.basename(dir),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  /** 旧布局判定:槽目录本身含市场内容(.agents 目录)。 */
  private looksLikeLegacyCache(slot: string): boolean {
    if (!fs.existsSync(slot)) return false;
    try {
      // lstat 拒符号链接:槽被换成指向别处的链接时,迁移会把外部目录的条目
      // rename 进版本目录(数据破坏 + 把外部内容当市场内容读)。槽必须是真目录。
      return fs.lstatSync(slot).isDirectory() && fs.existsSync(path.join(slot, '.agents'));
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
   * 清理历史版本:删除 versions/ 里非 current 的目录。是否真的能删由
   * `removeCacheDir` 的租约守卫决定 —— 刚被切下来的那一代往往正被并发的发现/
   * 详情/安装打包使用,守卫会把删除推迟到最后一个租约释放。
   */
  private async pruneStaleVersions(slot: string): Promise<void> {
    // 指针经 readAtomicFileSync 读取(含 .bak 恢复):Windows 备份交换失败后
    // 主文件缺失但 current.bak 仍是唯一有效指针,裸读会把"有 current"误判成
    // "无 current",清理逻辑与实际生效版本脱节。读不出指针(null / 抛错)一律
    // 不清理——事实不明时宁可多留磁盘,不冒删错的险。
    let current: string;
    try {
      const text = readAtomicFileSync(this.currentPointer(slot));
      if (text === null) return;
      current = text.trim();
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
      if (sameVersionName(entry, current)) continue;
      // 仅删除 versions/ 内的直接子目录,防穿越。
      if (entry.includes('/') || entry.includes('\\') || entry === '..' || entry === '.') continue;
      const dir = path.join(this.versionsDir(slot), entry);
      // 推迟期间该版本可能又成了 current(并发刷新把它激活了),执行前再核对。
      await this.removeCacheDir(dir, { skipIf: () => this.isCurrentVersionDir(dir) });
    }
    await this.pruneStaleIncoming(slot);
  }

  /**
   * 清理 incoming/ 里已死的暂存目录(进程在刷新途中被杀会留下残骸)。
   * 在途的暂存目录由租约守卫按前缀放过 —— git clone 的
   * `<incoming>.staging-<uuid>` 是兄弟目录,正好落在守卫的字符串前缀判据里。
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
      await this.removeCacheDir(path.join(root, entry));
    }
  }

  /**
   * 清理 cloneRoot 顶层的 `.incoming-*` / `.staging-*` 残骸(add 途中进程被杀
   * 遗留)。它们在任何 slot 之外,pruneStaleIncoming/Versions 都扫不到。仍被
   * 租约持有的(正在进行的 add)由 removeCachePath 守卫按前缀跳过。
   */
  private async pruneStaleCloneStaging(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.deps.cloneRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith('.incoming-') && !entry.startsWith('.staging-')) continue;
      await this.removeCacheDir(path.join(this.deps.cloneRoot, entry));
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
    // 进程在上次 add 途中被杀会在 cloneRoot 顶层留下 `.incoming-*`(及其
    // `.staging-*` 兄弟),这两者不在任何 slot 内,pruneStale* 扫不到,会永久
    // 占盘。新建前先扫掉未被租约持有的残骸(被持有的由守卫跳过)。
    await this.pruneStaleCloneStaging();
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
      await this.removeCacheDir(incoming);
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
      // 复用缓存槽的全过程(清残骸 → 落位 → 切指针 → 写配置)都对**整个槽**持租约。
      //
      // 这是必需的,而且比"先清理 + 等在途删除"更强:那两步只能处理"已经启动"的
      // 删除,而移除来源留下的那笔可能仍躺在 deferred 里,会在 settle 返回后、
      // store.add 之前因旧租约释放而启动 —— 那时 slotIsConfigured() 还是 false,
      // 于是它与紧随的 mkdir/rename 并发,把刚重建的槽删掉。持槽租约则让守卫
      // 无法启动这笔删除,等本段结束释放时配置已写入,skipIf 直接否决它。
      retainCachePath(slot);
      try {
        // 清掉同 slug 的历史残骸(带"槽已被配置占用则放弃"的再核对);此刻本方法
        // 自己持有槽租约,所以它必然被推迟,由本段末尾释放后统一判定。
        await this.removeCacheDir(slot, { skipIf: () => this.slotIsConfigured(slot) });
        // 已经启动的删除仍要等它跑完——租约挡不住早于它启动的那笔。
        await settleCachePathRemovals(slot);
        await fs.promises.mkdir(this.versionsDir(slot), { recursive: true });
        await renameWithRetry(discoveredRoot, dir);
        atomicWriteFileSync(this.currentPointer(slot), version);
        // 配置必须在**释放槽租约之前**写入:这样任何被推迟的整槽删除在释放时
        // 立刻看到"槽已被配置占用"并放弃,不存在中间空档。
        this.deps.store.add(config);
      } finally {
        releaseCachePath(slot);
      }
      return this.toSummary(config, discovered.marketplace);
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
      // 整槽递归删同样要过租约守卫:并发的详情发现/快照/安装打包可能正持有槽内
      // 某个版本目录,直接删会让它们读到一半 ENOENT(安装失败或来源误报无效)。
      // 守卫按重叠判定(租约在目标之下也算),把删除推迟到最后一个租约释放;
      // 配置已从 store 移除,来源对用户即刻消失,残留缓存只是延后回收。
      //
      // 推迟期间用户可能移除后立刻重新添加同名同源 —— 那会复用同一个槽,所以执行
      // 前必须再核对一次"槽是否仍被配置占用",否则会把刚重新添加的缓存删掉。
      const slot = this.cacheSlot(removed);
      await this.removeCacheDir(slot, { skipIf: () => this.slotIsConfigured(slot) });
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
    //
    // 两个候选暂存目录:快进用一个,回落重克隆用**另一个全新的**。不复用同一个
    // "先清理再重用"——清理要过租约守卫、可能被推迟,复用会让 clone 写进脏目录。
    // 两个都登记租约,守卫据此按前缀放过 git 的 `<dest>.staging-<uuid>` 兄弟目录。
    const staging = [this.incomingDir(slot), this.incomingDir(slot)] as const;
    const [fastForwardDir, cloneDir] = staging;
    for (const dir of staging) retainCachePath(dir);
    try {
      // 刷新同样往这个槽里写:先等与它重叠的在途删除结束,免得新版本被一笔"移除
      // 来源"遗留的在途整槽删除带走。
      await settleCachePathRemovals(slot);
      await fs.promises.mkdir(path.dirname(fastForwardDir), { recursive: true });
      await fs.promises.mkdir(this.versionsDir(slot), { recursive: true });
      // 快进要整目录复制当前版本并在其上 fetch:登记读取引用,否则并发刷新的
      // 清理能在复制途中删掉源目录。引用在快进段结束后立刻释放(见 finally)。
      const current = this.acquireCurrentVersion(config);
      // 两条路径(快进成功 / 重克隆)都会赋值或抛出,此处仅满足 TS 的确定性赋值分析。
      let revision = '';
      let stagedDir = fastForwardDir;
      let discovered: Extract<
        Awaited<ReturnType<typeof discoverMarketplace>>,
        { ok: true }
      >;
      try {
        let fastForwarded = false;
        if (current) {
          // 快进路径:复制当前版本到暂存目录,在暂存目录内快进。
          try {
            await fs.promises.cp(current, fastForwardDir, { recursive: true });
            revision = await fetchMarketplace(
              current,
              gitSource.ref,
              this.deps.gitExecutor,
              fastForwardDir,
            );
            fastForwarded = true;
          } catch {
            fastForwarded = false;
          }
        }
        if (!fastForwarded) {
          // 无当前版本或快进失败(历史改写/缓存损坏):整目录重克隆到另一个暂存目录。
          stagedDir = cloneDir;
          try {
            revision = await cloneMarketplace(
              {
                url: gitSource.url,
                ...(gitSource.ref ? { ref: gitSource.ref } : {}),
                sparsePaths: gitSource.sparsePaths,
              },
              cloneDir,
              this.deps.gitExecutor,
            );
          } catch (error) {
            if (error instanceof MarketGitError) throwIpcError(error.code, error.message);
            throw error;
          }
        }
        // 在暂存目录完成完整发现验证,通过后才落位并激活;失败时当前版本不动,
        // 暂存目录由本方法末尾的统一回收清掉。
        const staged = await discoverMarketplace(stagedDir);
        if (!staged.ok) {
          throwIpcError(staged.code, staged.detail ?? staged.code);
        }
        discovered = staged;
      } finally {
        // 快进段已结束(成功或回落重克隆),本次刷新不再使用旧版本目录。
        if (current) releaseCachePath(current);
      }
      // 落位前先登记引用:rename 进 versions/ 到切指针之间,新版本还不是 current,
      // 并发刷新的清理会把它当历史版本删掉。
      retainCachePath(newDir);
      try {
        try {
          await renameWithRetry(stagedDir, newDir);
          await this.activateVersion(slot, newVersion);
        } catch (error) {
          // 半落位目录交给守卫:它会在执行前再核对一次指针,指针一旦已经指向
          // newDir 就放弃删除——那时它是唯一有效缓存,删掉会留下"指针指向不存在
          // 目录"的槽,整个来源从列表消失。
          await this.removeCacheDir(newDir, { skipIf: () => this.isCurrentVersionDir(newDir) });
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
        releaseCachePath(newDir);
      }
    } finally {
      // 暂存目录统一在这里回收:成功的那个已被 rename 走、没用到的从未创建
      // (force rm 都是 no-op),失败的在这里清掉。先释放租约再删,守卫才会就地执行。
      for (const dir of staging) releaseCachePath(dir);
      for (const dir of staging) await this.removeCacheDir(dir);
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
