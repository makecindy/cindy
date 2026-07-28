/**
 * 语音词典多设备同步的 CRDT 状态模型。
 *
 * ## 为什么是这个形状
 *
 * 设备之间没有中心裁决者,relay 也不暂存离线消息(目标不在线直接失败),所以同步
 * 必须满足两件事:
 *
 *  1. **状态式合并**:每次交换整份状态,`mergeSyncStates` 幂等、可交换、可结合。
 *     丢帧、重复投递、乱序、任意轮数都不影响最终一致 —— 这次没送到,下次上线再
 *     合一次就收敛,不需要可靠投递、ack 或重传。
 *  2. **计数不能靠相加**:两台设备各学同一个词 3 次,正确结果是 6;但如果合并规则
 *     是「相加」,A 和 B 同步一轮各得 6,再同步一轮各得 12,词典会随同步次数指数
 *     膨胀。因此频次不存总数,存 {@link GCounter}:按节点分桶记录各自的累计事件数,
 *     **合并逐节点取 max**(不是相加),显示值才是求和。
 *
 * ## 化身(incarnation)
 *
 * 删除必须能跨设备传播,又不能误杀「删掉之后用户重新添加的同名词」。裸墓碑
 * (记下 textKey 就算删)做不到这一点:重新添加的词会被旧墓碑一直压着。
 *
 * 所以每个词条由若干**化身**组成,每个化身有全网唯一 tag(创建时的 HLC),而
 * **频次、别名、阶段都挂在化身上,不挂在词条上**。删除 = 对「删除者当时看得见的
 * 那些化身 tag」记墓碑(observed-remove)。于是:
 *
 *  - 删除会连同那些化身的计数一起带走,离线设备回来后不会把旧计数复活;
 *  - 重新添加产生新 tag,任何旧墓碑都覆盖不到它,天然是一条干净的新词条;
 *  - 「删除」与「并发重新添加」并发时 add-wins,用户新表达的意图胜出。
 *
 * 词条可见 ⇔ 至少有一个化身没有被墓碑覆盖;显示频次 = **只对存活化身**求和。
 */

import type { HlcTimestamp } from './hlc';
import { isCanonicalHlc } from './hlc';

/** 状态结构版本;不兼容改动 +1,收到更高版本的状态整份忽略而不是猜着合并。 */
export const VOICE_DICTIONARY_SYNC_VERSION = 1;

/**
 * 按节点分桶的增长计数器。key = 产生事件的节点 id,value = 该节点的累计事件数。
 *
 * 合并 = 逐 key 取 max(幂等);读取 = 所有 value 求和。
 * 只有事件的产生者才会递增自己那一桶,所以「同一个事件被合并进来很多次」不会
 * 让计数增长 —— 这是词典频次不会随同步次数膨胀的根本原因。
 */
export type GCounter = Record<string, number>;

/** 词条所处阶段。candidate 是攒证据阶段,entry 是已进入词典。单调:只能升不能降。 */
export type DictionaryStage = 'candidate' | 'entry';

/** 词条来源。单调:automatic → manual 单向,用户手动确认过的词不会退回自动。 */
export type DictionaryTermSource = 'manual' | 'automatic';

/** 别名(误识别写法)在单个化身内的状态。 */
export interface SyncAliasState {
  /** 展示用原文;LWW,由 {@link textStamp} 定序。 */
  text: string;
  textStamp: HlcTimestamp;
  /** 该别名被观察到的次数,按节点分桶。 */
  counters: GCounter;
  /** 最近一次观察到的墙钟毫秒;合并取 max,仅用于展示排序。 */
  lastSeenAt: number;
}

/**
 * 词条的一个化身。tag 全网唯一,创建后不可变;其余字段各自按自己的 CRDT 规则合并。
 */
export interface DictionaryIncarnation {
  /** 创建时的 HLC,同时是这个化身的全局唯一 id。 */
  tag: HlcTimestamp;
  /** 展示用原文(保留大小写);LWW,由 {@link textStamp} 定序。 */
  text: string;
  textStamp: HlcTimestamp;
  /** manual-wins 单调寄存器。 */
  source: DictionaryTermSource;
  /** entry-wins 单调寄存器。 */
  stage: DictionaryStage;
  /** 本化身的频次证据,按节点分桶。 */
  counters: GCounter;
  /** 别名表,key = 别名的归一化主键。 */
  aliases: Record<string, SyncAliasState>;
  /** 展示用时间;合并分别取 min / max。时钟回拨只影响展示排序,不影响正确性。 */
  createdAt: number;
  updatedAt: number;
}

/**
 * 一个词(按归一化文本主键)的全部化身与墓碑。
 *
 * 墓碑按化身 tag 记录,value 是删除操作的 HLC(用于 TTL 回收与确定性合并)。
 */
export interface DictionaryRecord {
  incarnations: Record<HlcTimestamp, DictionaryIncarnation>;
  tombstones: Record<HlcTimestamp, HlcTimestamp>;
}

/**
 * 「不要再自动学习这个词」的抑制集合。
 *
 * 用户删掉一条 automatic 词条时写入,阻止后台学习把它一路加回来 —— 这是 desktop
 * 现有的单机语义(`deleteVoiceInputDictionaryEntriesFromSettings`),同步只是把它
 * 扩展到全网。手动词条的删除**不写这里**,同样与现有单机语义一致:之后自动学习
 * 可以合法地重新学出来。
 *
 * 当前产品没有「解除抑制」入口,所以这里是只增集合(G-Set),value 记首次抑制的
 * HLC(合并取 min,保证确定性)。将来若要支持解除,需要升级为 OR-Set。
 */
export interface DictionarySuppression {
  text: string;
  stamp: HlcTimestamp;
}

/** 一份完整的可交换状态。JSON 可序列化:直接落盘、直接进 device-link push 帧。 */
export interface VoiceDictionarySyncState {
  version: typeof VOICE_DICTIONARY_SYNC_VERSION;
  /** key = 归一化词条主键。 */
  records: Record<string, DictionaryRecord>;
  /** key = 归一化词条主键。 */
  suppressed: Record<string, DictionarySuppression>;
}

/**
 * 建一个没有原型的字典对象。
 *
 * 词条主键直接来自用户输入,而 `constructor`、`toString`、`__proto__`、`valueOf`
 * 都是完全合法的技术术语。用普通 `{}` 的话 `'constructor' in records` 恒为真、
 * `records['toString']` 会取到继承来的函数 —— 于是这些词会被当成"已存在"而静默
 * 丢弃,或者把一个函数喂给只认记录结构的代码。所有以用户文本为键的对象一律用
 * 这个工厂建。
 */
export function createDictionaryMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * 复制成无原型字典。
 *
 * **不要用 `{ ...map }`**:对象字面量自带 `Object.prototype`,复制出来的东西再被
 * 别处按 `map[key]` 读取时,`__proto__` 这类键会命中原型上的访问器,拿到的不是
 * 词条而是原型对象本身(而且它 truthy,会一路蒙混到崩溃点才炸)。
 */
export function copyDictionaryMap<T>(map: Record<string, T> | undefined | null): Record<string, T> {
  const next = createDictionaryMap<T>();
  if (!map) return next;
  for (const key of Object.keys(map)) next[key] = map[key];
  return next;
}

/** 在无原型副本上写一个键,等价于安全版的 `{ ...map, [key]: value }`。 */
export function withDictionaryKey<T>(
  map: Record<string, T> | undefined | null,
  key: string,
  value: T,
): Record<string, T> {
  const next = copyDictionaryMap(map);
  next[key] = value;
  return next;
}

/** 自有属性检查。绝不用 `in`:它会命中原型链上的同名成员。 */
export function hasDictionaryKey(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export function createEmptySyncState(): VoiceDictionarySyncState {
  return {
    version: VOICE_DICTIONARY_SYNC_VERSION,
    records: createDictionaryMap(),
    suppressed: createDictionaryMap(),
  };
}

/**
 * 深度校验一份来自隧道的状态。
 *
 * 只校验顶层是不够的:一个 incarnation 少了 `counters`、或者 aliases 里塞了字符串,
 * 都能通过顶层检查并被持久化,然后在物化时才抛 —— 而且这份中毒的 sidecar 每次重启
 * 都会被重新接受,词典修改和同步会一直坏下去,直到有人手工删文件。宁可在入口拒收
 * 整帧。
 */
export function isValidSyncState(raw: unknown): raw is VoiceDictionarySyncState {
  if (!isPlainRecord(raw)) return false;
  const candidate = raw as Partial<VoiceDictionarySyncState>;
  if (candidate.version !== VOICE_DICTIONARY_SYNC_VERSION) return false;
  if (!isPlainRecord(candidate.records) || !isPlainRecord(candidate.suppressed)) return false;

  for (const record of Object.values(candidate.records)) {
    if (!isPlainRecord(record)) return false;
    const { incarnations, tombstones } = record as Partial<DictionaryRecord>;
    if (!isPlainRecord(incarnations) || !isPlainRecord(tombstones)) return false;
    // 墓碑的键是被覆盖的化身 tag,值是删除时刻的时间戳 —— 两者都参与定序与 TTL,
    // 都必须是规范 HLC。
    for (const [tag, value] of Object.entries(tombstones)) {
      if (!isCanonicalHlc(tag) || !isCanonicalHlc(value)) return false;
    }
    for (const [tag, incarnation] of Object.entries(incarnations)) {
      if (!isCanonicalHlc(tag)) return false;
      if (!isValidIncarnation(incarnation)) return false;
      // 键必须与化身自称的 tag 一致:不一致时墓碑按键匹配、比较按 tag 走,
      // 同一个化身会在两套判断下表现不同。
      if ((incarnation as Partial<DictionaryIncarnation>).tag !== tag) return false;
    }
  }

  for (const suppression of Object.values(candidate.suppressed)) {
    if (!isPlainRecord(suppression)) return false;
    const { text, stamp } = suppression as Partial<DictionarySuppression>;
    if (typeof text !== 'string' || !isCanonicalHlc(stamp)) return false;
  }
  return true;
}

function isValidIncarnation(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  const value = raw as Partial<DictionaryIncarnation>;
  if (!isCanonicalHlc(value.tag) || typeof value.text !== 'string') return false;
  if (!isCanonicalHlc(value.textStamp)) return false;
  if (value.source !== 'manual' && value.source !== 'automatic') return false;
  if (value.stage !== 'entry' && value.stage !== 'candidate') return false;
  // 必须是有限值:`NaN` / `Infinity` 的 typeof 也是 'number',放进来之后物化阶段的
  // `Math.min` / `Math.max` 会把它传播到整条词条的时间戳上,排序与展示随之失稳,
  // 而且这份中毒状态是持久化并继续同步出去的。
  if (!isValidTimestamp(value.createdAt) || !isValidTimestamp(value.updatedAt)) return false;
  if (!isValidCounter(value.counters)) return false;
  if (!isPlainRecord(value.aliases)) return false;
  for (const alias of Object.values(value.aliases)) {
    if (!isPlainRecord(alias)) return false;
    const aliasValue = alias as Partial<SyncAliasState>;
    if (typeof aliasValue.text !== 'string' || !isCanonicalHlc(aliasValue.textStamp)) return false;
    if (!isValidTimestamp(aliasValue.lastSeenAt)) return false;
    if (!isValidCounter(aliasValue.counters)) return false;
  }
  return true;
}

/**
 * 计数桶。
 *
 * 语义是「事件累计次数」,所以只接受非负安全整数。放行负数或小数的话,展示读数会被
 * `Math.floor` 悄悄改写 —— 症状出现在离入口很远的地方,而真正的原因(某一帧带了坏
 * 计数)已经无从追溯;况且负计数还能让合并的逐节点 max 表现出反直觉的结果。
 */
function isValidCounter(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  for (const value of Object.values(raw)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
  }
  return true;
}

/** 毫秒时间戳:有限、非负。 */
function isValidTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 普通对象(排除 null 与数组 —— 两者的 typeof 都是 'object')。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 存活化身 = 没有被墓碑覆盖的化身。词条的一切对外读数都只看这些。 */
export function listLiveIncarnations(record: DictionaryRecord): DictionaryIncarnation[] {
  return Object.values(record.incarnations)
    .filter((incarnation) => !hasDictionaryKey(record.tombstones, incarnation.tag))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** 计数器读数:所有节点分桶求和。 */
export function readCounterTotal(counters: GCounter): number {
  let total = 0;
  for (const value of Object.values(counters)) {
    if (Number.isFinite(value) && value > 0) total += Math.floor(value);
  }
  return total;
}
