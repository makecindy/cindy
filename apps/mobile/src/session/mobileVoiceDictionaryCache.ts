/**
 * 手机端的语音词典缓存。
 *
 * 词典的正本在桌面(桌面之间用 CRDT 对等同步),手机只拉一份只读快照:移动端在
 * 后台不维持 WebSocket,收不到对等同步的 push 帧,持有可写副本只会分叉。
 *
 * 按 host 设备分别缓存并落盘,原因是「桌面此刻不在线」也要能用:润色需要的词典
 * 来自上次成功拉取的结果,而不是每次都必须现拉。拉取失败(桌面离线、老版本被控端
 * 回 CHANNEL_NOT_ALLOWED)一律静默降级到缓存,绝不打断语音输入。
 *
 * 落盘走 AsyncStorage 而不是 SecureStore:一份词典快照可能上百 KB,而 SecureStore
 * 背后是平台钥匙串,大值会被拒绝(且这里刻意吞掉写入错误),结果是缓存只在内存里
 * 有效、进程一死就没了,说好的离线兜底名存实亡。词典是用户内容不是密钥材料,
 * SecureStore 留给真正的凭证。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { hlcNodeId, isCanonicalHlc } from '@cindy/voice-input-core';
import { listMobileVoiceHistoryHosts } from '@/session/mobileVoiceHistoryStore';
import type {
  MobileVoiceCredentialSyncDictionaryEntry,
  MobileVoiceDictionarySnapshotResult,
} from '@cindy/maker-shared/device-link-contract';

// v2 起键里带账号:登出清理是尽力而为的(AsyncStorage 不能按前缀枚举,索引也可能
// 读不出来),只靠清理保证账号隔离等于把用户词条的去向押在一次可能失败的删除上。
// 键带账号之后,即使某份快照没删掉,下一个账号也读不到它。
const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceDictionary.v2';
const LEGACY_STORAGE_KEY_PREFIX = 'xdt.mobileVoiceDictionary.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;
const LEGACY_STORAGE_INDEX_KEY = `${LEGACY_STORAGE_KEY_PREFIX}.hosts`;

/**
 * 当前账号标识。登录/登出时由 AuthContext 设置。
 *
 * 空串是合法状态(未登录):此时读写都退回到一个独立分区,不会和任何账号的数据
 * 互相看见。
 */
let accountScope = '';

/**
 * 本会话见过的所有账号分区。
 *
 * 登出时 `applyUser(null)` 会先把分区切回匿名,清理才异步跑起来 —— 清理入口读到的
 * 已经是匿名分区,只删匿名那份的话,正在登出的那个账号的快照会原封不动留在盘上。
 * 记下见过的分区,清理时逐个删。
 */
const knownScopes = new Set<string>(['']);

/** 设置账号分区。切换账号时同时递增代际,丢弃在途请求。 */
export function setMobileVoiceDictionaryAccountScope(accountId: string): void {
  const next = typeof accountId === 'string' ? accountId.trim() : '';
  knownScopes.add(next);
  if (next === accountScope) return;
  accountScope = next;
  cacheEpoch += 1;
  memoryCache.clear();
  inFlight.clear();
}
/** 与桌面词典上限一致;手机侧只是防御性截断,避免异常大的回包撑爆存储。 */
const MAX_ENTRIES = 1_000;
const MAX_ALIASES_PER_ENTRY = 8;
/** 同一 host 的最小重拉间隔:词典变化慢,没必要每次开麦都打一次 invoke。 */
const REFETCH_INTERVAL_MS = 5 * 60 * 1000;

type CachedDictionary = {
  entries: MobileVoiceCredentialSyncDictionaryEntry[];
  fetchedAt: number;
  /** 被控端上报的版本向量;老版本不带,此时只能退回按 fetchedAt 比较。 */
  stateVector?: Record<string, string>;
};

const memoryCache = new Map<string, CachedDictionary>();
/**
 * 在途请求。键带账号分区 —— 只按 host 去重的话,账号切走之后新账号的刷新会拿到
 * 上一个账号那个还挂着的请求并一直等它,而那个请求的结果按代际检查又必然被丢弃:
 * 新账号什么也拿不到,调用方却以为刷新过了。
 */
const inFlight = new Map<string, Promise<void>>();
/**
 * 缓存代际。账号边界清理时递增,在途请求据此判断自己是否已经过期。
 *
 * 只把 inFlight 清空是不够的:那只是丢掉了 Promise 的引用,请求本身还在飞,回来
 * 时照样会写进内存缓存 —— 于是上个账号的词典在登出之后又被复活。
 */
let cacheEpoch = 0;

export function readCachedMobileVoiceDictionary(
  hostDeviceId: string,
): MobileVoiceCredentialSyncDictionaryEntry[] {
  return memoryCache.get(normalizeHostDeviceId(hostDeviceId))?.entries ?? [];
}

/** 上次成功拉取的时间(unix ms);从未拉到过返回 null。设置页据此区分「没有词典」与「还没拉过」。 */
export function readMobileVoiceDictionaryFetchedAt(hostDeviceId: string): number | null {
  const cached = memoryCache.get(normalizeHostDeviceId(hostDeviceId));
  return cached && cached.fetchedAt > 0 ? cached.fetchedAt : null;
}

/**
 * 读一台电脑的缓存快照(含拉取时间)。
 *
 * 展示层要靠 fetchedAt 挑出最新那份 —— 离线电脑的旧缓存不能和新鲜数据混在一起,
 * 否则已经删掉的词会被旧快照带回来。
 */
export function readCachedMobileVoiceDictionarySnapshot(hostDeviceId: string): {
  entries: MobileVoiceCredentialSyncDictionaryEntry[];
  fetchedAt: number;
  stateVector?: Record<string, string>;
} {
  const cached = memoryCache.get(normalizeHostDeviceId(hostDeviceId));
  return {
    entries: cached?.entries ?? [],
    fetchedAt: cached?.fetchedAt ?? 0,
    stateVector: cached?.stateVector,
  };
}

/** 从盘上恢复缓存(App 启动或首次用到该 host 时调用一次)。 */
export async function hydrateMobileVoiceDictionary(hostDeviceId: string): Promise<void> {
  const host = normalizeHostDeviceId(hostDeviceId);
  if (memoryCache.has(host)) return;
  // 磁盘读同样要受代际保护:登出可能恰好发生在 getItem 在途时,读回来再写内存
  // 就把上个账号的词典复活了。
  const epoch = cacheEpoch;
  const scope = accountScope;
  try {
    const raw = await AsyncStorage.getItem(storageKeyForHost(host, scope));
    if (!raw) return;
    if (epoch !== cacheEpoch) return;
    const parsed = JSON.parse(raw) as Partial<CachedDictionary>;
    const restored = {
      entries: normalizeEntries(parsed?.entries),
      fetchedAt: typeof parsed?.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      stateVector: normalizeStateVector(parsed?.stateVector),
    };
    // 开麦路径会并发跑 hydrate 与 refresh。磁盘读晚于网络响应返回时,不能用旧
    // 快照盖掉刚拉到的新数据 —— 只在内存仍为空、或盘上确实更新时才写。
    const current = memoryCache.get(host);
    if (current && current.fetchedAt >= restored.fetchedAt) return;
    memoryCache.set(host, restored);
  } catch {
    // 缓存读坏了就当没有:下一次拉取会重建。
  }
}

/**
 * 需要时刷新缓存。
 *
 * fire-and-forget 语义:调用方不必 await,拿当前缓存直接用就行 —— 这次拉到的
 * 内容供下一次润色使用,不会为了词典把开麦流程卡住。
 */
export async function refreshMobileVoiceDictionary(
  hostDeviceId: string,
  fetchSnapshot: () => Promise<MobileVoiceDictionarySnapshotResult>,
  options?: { force?: boolean },
): Promise<void> {
  const host = normalizeHostDeviceId(hostDeviceId);
  if (!host) return;
  // epoch 与分区都必须在第一个 await 之前取。
  //
  // epoch 取晚了会读到清理后的新值,于是这份属于上个账号的响应被判成"仍然有效"。
  // 分区取晚了更糟:下面每一次算 key 都发生在若干个挂起点之后,拿到的是**当前**
  // 分区 —— 账号在这期间切走的话,旧账号的响应会写进新账号的分区,而末尾那次
  // 补偿删除又会把新账号刚写的快照删掉。两者都只能在入口锁定。
  const epoch = cacheEpoch;
  const scope = accountScope;
  await hydrateMobileVoiceDictionary(host);

  const cached = memoryCache.get(host);
  if (!options?.force && cached && Date.now() - cached.fetchedAt < REFETCH_INTERVAL_MS) return;

  const inFlightKey = `${scope}\u0000${host}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;

  const task = (async () => {
    try {
      const result = await fetchSnapshot();
      if (!result?.ok) return;
      // 请求期间发生过账号边界清理:这份数据属于上一个账号,丢弃。
      if (epoch !== cacheEpoch) return;
      const next: CachedDictionary = {
        entries: normalizeEntries(result.entries),
        fetchedAt: Date.now(),
        stateVector: normalizeStateVector(result.stateVector),
      };
      memoryCache.set(host, next);
      // 顺序很关键:**先登记索引,再写快照**。两个写不是原子的,进程随时可能死在
      // 中间 —— 索引里多一条(快照还没写)只是清理时删一个不存在的 key,无害;
      // 反过来快照落了盘而索引没登记,登出就枚举不到它,下个账号用同一台电脑会
      // hydrate 到上个账号的词典。宁可多登记,不可漏登记。
      // 索引登记失败就不要写快照:写了也是枚举不到的孤儿,登出删不掉,下个账号
      // 用同一台电脑会 hydrate 到上个账号的词典。缓存只在内存里有效即可。
      try {
        await addHostToIndex(host);
      } catch {
        return;
      }
      await AsyncStorage.setItem(storageKeyForHost(host, scope), JSON.stringify(next)).catch(
        () => undefined,
      );
      // 落盘与索引写入都是异步的,清理完全可能发生在这中间 —— 那样这份属于上个
      // 账号的快照会在删除之后重新出现在盘上。写完再确认一次代际,过期就自己清掉。
      if (epoch !== cacheEpoch) {
        memoryCache.delete(host);
        // 只删自己刚写的那一份(按入口锁定的分区),不碰新账号已经提交的快照。
        await AsyncStorage.removeItem(storageKeyForHost(host, scope)).catch(() => undefined);
      }
    } catch {
      // 桌面离线、老被控端不识别该 channel、隧道抖动 —— 一律沿用现有缓存。
    } finally {
      inFlight.delete(inFlightKey);
    }
  })();
  inFlight.set(inFlightKey, task);
  return task;
}

/**
 * 账号边界清理:退出登录 / 切换账号时抹掉所有词典缓存。
 *
 * 缓存键只按 host 设备分区,不含账号身份 —— 同一台电脑在账号 A 和账号 B 下是同
 * 一个 deviceId。不清理的话,账号 B 会读到账号 A 留下的词条,并经润色上下文发给
 * 模型,属于跨账号的数据泄漏。与语音凭证、语音历史挂在同一条登出链路上
 * (`AuthContext` 调用 `clearAllMobileVoiceCredentials` 的地方)。
 *
 * 内存与在途请求一并清掉:登出瞬间可能有 refresh 正在返回,只清盘会被它写回来。
 */
export async function clearAllMobileVoiceDictionaryCaches(): Promise<void> {
  cacheEpoch += 1;
  memoryCache.clear();
  inFlight.clear();
  // SecureStore 不能枚举键,只能从可推导的 host 集合尽力清理:本模块自己的索引,
  // 并集语音历史的 host 索引(用过语音输入的 host 必定拉取过词典)。
  const [ownHosts, historyHosts] = await Promise.all([
    readHostIndex(),
    listMobileVoiceHistoryHosts().catch(() => [] as string[]),
  ]);
  const hosts = [...new Set([...(ownHosts.hosts ?? []), ...historyHosts])];
  // 逐个已知分区删:清理往往在分区已经被切回匿名之后才跑到这里,只删当前分区会把
  // 正在登出的那个账号的快照留在盘上。
  const scopes = [...knownScopes];
  await Promise.all(
    hosts.flatMap((host) => [
      ...scopes.map((scope) =>
        AsyncStorage.removeItem(storageKeyForHost(host, scope)).catch(() => undefined),
      ),
      // v1 的键不带账号,是真正会被下个账号读到的那一份 —— 一并尽力删掉。
      AsyncStorage.removeItem(legacyStorageKeyForHost(host)).catch(() => undefined),
    ]),
  );
  // 索引读失败时**不能**删索引:那等于把「还有哪些快照没删」的唯一线索也丢掉,
  // 剩下的快照就永远清不掉了。留着,下次登出或下次写入时还有机会补删。
  if (ownHosts.readable) {
    await AsyncStorage.removeItem(STORAGE_INDEX_KEY).catch(() => undefined);
    await AsyncStorage.removeItem(LEGACY_STORAGE_INDEX_KEY).catch(() => undefined);
  }
}

/**
 * 读 host 索引。
 *
 * `readable` 区分「索引确实是空的」和「读不出来/坏了」—— 后者当成空列表处理会让
 * 清理误以为无事可做,还顺手把索引删掉,剩下的快照就此失去唯一的枚举线索。
 */
async function readHostIndex(): Promise<{ hosts: string[]; readable: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_INDEX_KEY);
    if (!raw) return { hosts: [], readable: true };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { hosts: [], readable: false };
    return {
      hosts: parsed.filter((item): item is string => typeof item === 'string'),
      readable: true,
    };
  } catch {
    return { hosts: [], readable: false };
  }
}

/**
 * 索引写入串行队列。
 *
 * 设置页会并发刷新多台在线电脑,每个 `addHostToIndex` 都是 read-modify-write:
 * 并发时后写的会覆盖先写的,某些 host 的缓存键就不在索引里了。而索引是登出清理
 * 唯一的枚举来源 —— 漏掉的那份快照删不掉,下一个账号用同一台电脑就会 hydrate 到
 * 上个账号的词典并发给润色模型。
 */
let hostIndexQueue: Promise<void> = Promise.resolve();

function addHostToIndex(hostDeviceId: string): Promise<void> {
  hostIndexQueue = hostIndexQueue
    .catch(() => undefined)
    .then(async () => {
      const index = await readHostIndex();
      if (index.hosts.includes(hostDeviceId)) return;
      await AsyncStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify([...index.hosts, hostDeviceId]));
    });
  return hostIndexQueue;
}

export function __resetMobileVoiceDictionaryCacheForTests(): void {
  cacheEpoch += 1;
  memoryCache.clear();
  inFlight.clear();
}

function normalizeEntries(raw: unknown): MobileVoiceCredentialSyncDictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: MobileVoiceCredentialSyncDictionaryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<MobileVoiceCredentialSyncDictionaryEntry>;
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    if (!text) continue;
    entries.push({
      text,
      frequency: readPositiveInt(candidate.frequency),
      aliases: Array.isArray(candidate.aliases)
        ? candidate.aliases
            .map((alias) => {
              const aliasText = typeof alias?.text === 'string' ? alias.text.trim() : '';
              return aliasText ? { text: aliasText, count: readPositiveInt(alias?.count) } : null;
            })
            .filter((alias): alias is { text: string; count: number } => alias !== null)
            .slice(0, MAX_ALIASES_PER_ENTRY)
        : [],
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

/**
 * 归一化被控端上报的版本向量;形状不对一律当作「没有」,退回按拉取时间比较。
 *
 * 新鲜度判断靠的是字符串字典序,而那只在时间戳是规范 HLC(定长前缀)时才等于时间序。
 * 混进一个 `~~~~`(`~` 的码位高于所有 base36 字符)就会在每一次比较里永远胜出,
 * 手机从此长期停在错误的快照上,表现成「怎么刷新都不更新」。所以逐项按规范形状过滤,
 * 并要求时间戳自带的 nodeId 与它的键一致 —— 对不上说明这份向量本身就不自洽。
 */
function normalizeStateVector(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  // nodeId 来自远端。用普通 {} 的话,一个叫 __proto__ 的键会走原型 setter,
  // 后面的包含性比较读到的就不是写进去的东西。
  const vector = Object.create(null) as Record<string, string>;
  for (const [nodeId, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodeId || typeof stamp !== 'string' || !isCanonicalHlc(stamp)) continue;
    if (hlcNodeId(stamp) !== nodeId) continue;
    vector[nodeId] = stamp;
  }
  return Object.keys(vector).length > 0 ? vector : undefined;
}

function storageKeyForHost(hostDeviceId: string, scope: string = accountScope): string {
  return `${STORAGE_KEY_PREFIX}.${scope || 'anonymous'}.${hostDeviceId}`;
}

function legacyStorageKeyForHost(hostDeviceId: string): string {
  return `${LEGACY_STORAGE_KEY_PREFIX}.${hostDeviceId}`;
}

function normalizeHostDeviceId(hostDeviceId: string): string {
  return typeof hostDeviceId === 'string' ? hostDeviceId.trim() : '';
}
