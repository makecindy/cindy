/**
 * 自定义市场来源配置的持久化（sources.v1.json）。
 *
 * 与 PluginMarketLedger 同一套约定：schemaVersion 闸、逐条校验、原子写
 * （临时文件 + rename，Windows 下先删目标重试）、0o600。只存来源配置，
 * 不复制发现到的插件数据——快照时重新发现，磁盘上的克隆目录才是事实。
 */
import type { MarketSource, MarketSourceConfig } from '../../../shared/pluginMarket.js';
import { marketSourceKey } from '../../../shared/pluginMarket.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile.js';

const SOURCES_SCHEMA_VERSION = 1;

interface MarketSourcesData {
  schemaVersion: typeof SOURCES_SCHEMA_VERSION;
  sources: MarketSourceConfig[];
}

function emptySources(): MarketSourcesData {
  return { schemaVersion: SOURCES_SCHEMA_VERSION, sources: [] };
}

function validSource(value: unknown): value is MarketSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.type === 'local') {
    return typeof source.path === 'string' && source.path.length > 0;
  }
  if (source.type === 'git') {
    return (
      typeof source.url === 'string' &&
      source.url.length > 0 &&
      (source.ref === undefined || typeof source.ref === 'string') &&
      Array.isArray(source.sparsePaths) &&
      (source.sparsePaths as unknown[]).every((entry) => typeof entry === 'string')
    );
  }
  return false;
}

function validConfig(value: unknown): value is MarketSourceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.name === 'string' &&
    config.name.length > 0 &&
    typeof config.addedAt === 'string' &&
    (config.lastSyncedAt === null || typeof config.lastSyncedAt === 'string') &&
    (config.lastRevision === null || typeof config.lastRevision === 'string') &&
    validSource(config.source)
  );
}

export class MarketSourceStore {
  constructor(private readonly filePathSource: string | (() => string)) {}

  /**
   * Binds a dynamic owner-scoped store to the path captured at operation start.
   * Mirrors PluginMarketLedger.bind so owner switches never cross-write state.
   */
  bind(filePath: string): MarketSourceStore {
    return typeof this.filePathSource === 'function'
      ? new MarketSourceStore(filePath)
      : this;
  }

  private filePath(): string {
    return typeof this.filePathSource === 'function'
      ? this.filePathSource()
      : this.filePathSource;
  }

  list(): MarketSourceConfig[] {
    return this.read().sources;
  }

  get(name: string): MarketSourceConfig | null {
    return this.read().sources.find((source) => source.name === name) ?? null;
  }

  /** 追加新来源；调用方负责先完成名称与重复来源校验。 */
  add(config: MarketSourceConfig): void {
    const data = this.read();
    data.sources = [...data.sources.filter((source) => source.name !== config.name), config];
    this.write(data);
  }

  update(name: string, patch: Partial<Pick<MarketSourceConfig, 'lastSyncedAt' | 'lastRevision'>>): void {
    const data = this.read();
    const index = data.sources.findIndex((source) => source.name === name);
    if (index < 0) return;
    data.sources[index] = { ...data.sources[index]!, ...patch };
    this.write(data);
  }

  remove(name: string): MarketSourceConfig | null {
    const data = this.read();
    const existing = data.sources.find((source) => source.name === name) ?? null;
    if (!existing) return null;
    data.sources = data.sources.filter((source) => source.name !== name);
    this.write(data);
    return existing;
  }

  /** 重复添加判定：来源类型 + 定位 + 引用 + 稀疏路径全部一致视为同一来源。 */
  hasEquivalent(source: MarketSource): boolean {
    return this.read().sources.some((config) => sourcesEqual(config.source, source));
  }

  private read(): MarketSourcesData {
    // 读取入口恢复 .bak:主文件缺失时若直接读成空来源表,调用方随后的写入会用这份
    // 空数据永久覆盖唯一有效快照(全部自定义来源配置丢失)。
    //
    // 读失败与解析失败分开处理:文件不存在(ENOENT)才是空来源表;文件在但读不到
    // (文件锁/权限/瞬时 I/O)或备份救不回来时一律**上抛**。只有"内容确实不是合法
    // JSON"才按空来源表重建。
    const text = readAtomicFileSync(this.filePath());
    if (text === null) return emptySources();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return emptySources();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySources();
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== SOURCES_SCHEMA_VERSION) return emptySources();
    if (!Array.isArray(value.sources)) return emptySources();
    return { schemaVersion: SOURCES_SCHEMA_VERSION, sources: value.sources.filter(validConfig) };
  }

  private write(data: MarketSourcesData): void {
    atomicWriteFileSync(this.filePath(), `${JSON.stringify(data, null, 2)}\n`);
  }
}

/**
 * 两个来源是否同一个。判据直接复用 `marketSourceKey` —— 它就是本仓库对"来源身份"
 * 的唯一定义(账本所有权校验、缓存 slug 都用它),这里再写一套等价逻辑只会漂移。
 *
 * 尤其不能用 `sparsePaths.join('\n')` 比较列表:分隔符碰撞(`['a\nb']` 与
 * `['a','b']` join 结果相同)会让两个不同的来源被判成同一个。`marketSourceKey`
 * 用 JSON 序列化,数组边界不可伪造(它自己也有碰撞对抗测试)。当前 parse 层的
 * FORBIDDEN_SOURCE_CHARS 已经拒掉换行、这条路走不通,但身份判据不该依赖"上游恰好
 * 拦住了某个字符"这种远距离前提。
 */
export function sourcesEqual(a: MarketSource, b: MarketSource): boolean {
  return marketSourceKey(a) === marketSourceKey(b);
}
