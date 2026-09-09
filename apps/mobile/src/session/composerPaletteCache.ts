/**
 * composerPaletteCache.ts — @ 资源 / slash 命令面板的跨页内存缓存。
 * ---------------------------------------------------------------------------
 * 旧行为:@ 面板每敲一个字符打一次远端 scanAtResources(cap 2000、经 device-link,
 * 弱网逐键卡顿);slash 面板每次开合重拉。而本地已有 filterAtResources 打分过滤,
 * 远端逐键过滤只在结果被 cap 截断(truncated)时才有增量价值。
 *
 * 新模型(页面侧配合):
 *   - @:打开面板拉一次全量(无 query)并写缓存;全量未截断 → 后续逐键纯本地过滤,
 *     零远端流量;截断 → 先画缓存,query 变化 debounce 后再打远端补搜。
 *     TTL 内重开面板直接命中,不重拉(文件列表分钟级变化,60s 足够新鲜)。
 *   - slash:任意年龄的缓存先画(重开不闪 spinner),后台静默刷新覆盖(规则 7:
 *     先有内容再刷新)。
 *
 * 模块级 Map,会话页 / 新建页共享;按 device + agent + workingDir + 可选 session 键控。
 * 纯逻辑,时钟注入,node 可单测。
 */
import type { MobileAtResourceItem, MobileSlashCommand } from '@/device-link/mobileMakerTransport';

export interface CachedAtResourceScan {
  items: readonly MobileAtResourceItem[];
  truncated: boolean;
}

/** @ 全量扫描缓存的新鲜期;截断补搜(带 query)不进缓存。 */
export const AT_RESOURCE_SCAN_TTL_MS = 60 * 1000;
/** 截断仓库下逐键补搜的 debounce,避免每键一次远端往返。 */
export const AT_RESOURCE_QUERY_DEBOUNCE_MS = 300;

interface AtCacheEntry {
  result: CachedAtResourceScan;
  cachedAtMs: number;
}

const atScanCache = new Map<string, AtCacheEntry>();
const slashCache = new Map<string, readonly MobileSlashCommand[]>();

/**
 * key 各段分隔符:NUL 不会出现在 deviceId / agentKind / workingDir 里,拼接无歧义
 * (workingDir 可含空格,不能用空格分隔)。必须写显式 \u0000 转义,不能是裸 NUL
 * 字节——裸字节肉眼与 diff 均不可见,曾导致驱逐前缀误写成空格、按设备驱逐从未
 * 命中(codex review R13);构造与驱逐一律引用本常量,杜绝两边口径漂移。
 */
const KEY_SEPARATOR = '\u0000';

export function buildComposerPaletteCacheKey(
  deviceId: string,
  agentKind: string,
  workingDir: string,
  sessionId?: string,
): string {
  return [deviceId, agentKind, workingDir, sessionId ?? ''].join(KEY_SEPARATOR);
}

/** 读 @ 全量扫描缓存;stale(过 TTL)时也返回但标记,便于「先画旧数据再后台刷新」。 */
export function readAtResourceScanCache(
  key: string,
  now = Date.now(),
): { result: CachedAtResourceScan; fresh: boolean } | null {
  const entry = atScanCache.get(key);
  if (!entry) return null;
  return { result: entry.result, fresh: now - entry.cachedAtMs < AT_RESOURCE_SCAN_TTL_MS };
}

export function writeAtResourceScanCache(
  key: string,
  result: CachedAtResourceScan,
  now = Date.now(),
): void {
  atScanCache.set(key, { result, cachedAtMs: now });
}

export function readSlashCommandCache(key: string): readonly MobileSlashCommand[] | null {
  return slashCache.get(key) ?? null;
}

export function writeSlashCommandCache(key: string, commands: readonly MobileSlashCommand[]): void {
  slashCache.set(key, commands);
}

/** device-link:设备撤销授权 / 掉线时按 deviceId 前缀驱逐(与 providers / capabilities
 *  同时机)——桌面端重连 / 升级后 @ 资源与 slash 列表必须重取,不能拿旧连接的结果直接可插入。 */
export function evictComposerPaletteCacheForDevice(deviceId: string): void {
  const prefix = `${deviceId}${KEY_SEPARATOR}`;
  for (const key of atScanCache.keys()) {
    if (key.startsWith(prefix)) atScanCache.delete(key);
  }
  for (const key of slashCache.keys()) {
    if (key.startsWith(prefix)) slashCache.delete(key);
  }
}

/** 清空全部缓存(登出账号隔离用;测试亦复用)。 */
export function resetComposerPaletteCache(): void {
  atScanCache.clear();
  slashCache.clear();
}
