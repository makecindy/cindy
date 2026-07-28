/**
 * 状态合并 —— 整个同步方案的正确性所在。
 *
 * 本模块的每个函数都必须满足三条代数性质(由 `dictionarySyncMerge.test.ts` 的
 * 随机性质测试守护):
 *
 *   幂等  merge(a, a) = a
 *   交换  merge(a, b) = merge(b, a)
 *   结合  merge(merge(a, b), c) = merge(a, merge(b, c))
 *
 * 满足这三条,同步链路就不需要任何可靠投递保证:丢帧、重复投递、乱序、设备以
 * 任意拓扑任意轮数互相合并,最终状态都相同。改这里的任何一行之前,先确认新逻辑
 * 仍然满足这三条 —— 尤其**不要把任何计数改成相加**,那会破坏幂等并让词典频次
 * 随同步次数膨胀。
 */

import { compareHlc, hlcNodeId, maxHlc, minHlc, type HlcTimestamp } from './hlc';
import {
  VOICE_DICTIONARY_SYNC_VERSION,
  createDictionaryMap,
  createEmptySyncState,
  type DictionaryIncarnation,
  type DictionaryRecord,
  type DictionaryStage,
  type DictionarySuppression,
  type DictionaryTermSource,
  type GCounter,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from './types';

/**
 * 逐节点取 max。
 *
 * **不是相加** —— 相加会破坏幂等:A 和 B 各持 {A:3},相加后各得 6,再同步一轮
 * 各得 12,如此指数膨胀。只有产生事件的节点会递增自己那一桶,所以对同一份事件
 * 历史,逐节点 max 得到的正是每个节点的真实事件数,求和即全局真实总数。
 */
export function mergeCounters(a: GCounter, b: GCounter): GCounter {
  const merged: GCounter = createDictionaryMap<number>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = normalizeCount(a[key]);
    const right = normalizeCount(b[key]);
    const value = Math.max(left, right);
    if (value > 0) merged[key] = value;
  }
  return merged;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** LWW 寄存器:HLC 大者胜;完全相同的时间戳只可能来自同一次写入,取值也相同。 */
function mergeLww<T>(
  a: { value: T; stamp: HlcTimestamp },
  b: { value: T; stamp: HlcTimestamp },
): { value: T; stamp: HlcTimestamp } {
  const order = compareHlc(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;
  // 时间戳相等时按值排序做 tie-break:HLC 全局唯一,理论上走不到这里,但保证
  // 合并对「构造出来的异常状态」也是确定性的,不会让两台设备算出不同结果。
  return String(a.value) >= String(b.value) ? a : b;
}

function mergeAliasState(a: SyncAliasState, b: SyncAliasState): SyncAliasState {
  const text = mergeLww({ value: a.text, stamp: a.textStamp }, { value: b.text, stamp: b.textStamp });
  return {
    text: text.value,
    textStamp: text.stamp,
    counters: mergeCounters(a.counters, b.counters),
    lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
  };
}

function mergeAliases(
  a: Record<string, SyncAliasState>,
  b: Record<string, SyncAliasState>,
): Record<string, SyncAliasState> {
  const merged: Record<string, SyncAliasState> = createDictionaryMap<SyncAliasState>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (left && right) merged[key] = mergeAliasState(left, right);
    else merged[key] = left ?? right;
  }
  return merged;
}

/** manual-wins:用户手动确认过的词条不会因为后台自动学习退回 automatic。 */
function mergeSource(a: DictionaryTermSource, b: DictionaryTermSource): DictionaryTermSource {
  return a === 'manual' || b === 'manual' ? 'manual' : 'automatic';
}

/** entry-wins:任一端把候选晋升为正式词条,合并后全网都是正式词条。 */
function mergeStage(a: DictionaryStage, b: DictionaryStage): DictionaryStage {
  return a === 'entry' || b === 'entry' ? 'entry' : 'candidate';
}

/**
 * 同 tag 的两份化身副本合并。tag 相同意味着它们源自同一次创建,差异只可能来自
 * 各自后续观察到的事件。
 */
function mergeIncarnation(a: DictionaryIncarnation, b: DictionaryIncarnation): DictionaryIncarnation {
  const text = mergeLww({ value: a.text, stamp: a.textStamp }, { value: b.text, stamp: b.textStamp });
  return {
    tag: a.tag,
    text: text.value,
    textStamp: text.stamp,
    source: mergeSource(a.source, b.source),
    stage: mergeStage(a.stage, b.stage),
    counters: mergeCounters(a.counters, b.counters),
    aliases: mergeAliases(a.aliases, b.aliases),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

function mergeRecord(a: DictionaryRecord, b: DictionaryRecord): DictionaryRecord {
  const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = createDictionaryMap<DictionaryIncarnation>();
  for (const tag of new Set([...Object.keys(a.incarnations), ...Object.keys(b.incarnations)])) {
    const left = a.incarnations[tag];
    const right = b.incarnations[tag];
    if (left && right) incarnations[tag] = mergeIncarnation(left, right);
    else incarnations[tag] = left ?? right;
  }

  // 墓碑是只增集合:一旦某个化身被删,任何一方的合并结果里它都保持被删。
  // 同 tag 的删除时间取 max —— 取 min 会让墓碑提前过 TTL 被回收,给「离线设备
  // 回来复活旧化身」多开一道门。
  const tombstones: Record<HlcTimestamp, HlcTimestamp> = createDictionaryMap<HlcTimestamp>();
  for (const tag of new Set([...Object.keys(a.tombstones), ...Object.keys(b.tombstones)])) {
    const left = a.tombstones[tag];
    const right = b.tombstones[tag];
    tombstones[tag] = left && right ? maxHlc(left, right) : (left ?? right);
  }

  return { incarnations, tombstones };
}

/** 抑制项取首次抑制时间(min),保证与合并顺序无关。 */
function mergeSuppression(a: DictionarySuppression, b: DictionarySuppression): DictionarySuppression {
  const order = compareHlc(a.stamp, b.stamp);
  const stamp = minHlc(a.stamp, b.stamp);
  const text = order === 0 ? (a.text >= b.text ? a.text : b.text) : order < 0 ? a.text : b.text;
  return { text, stamp };
}

/**
 * 合并两份完整状态。纯函数:两个入参都不被修改。
 *
 * 版本更高的一方原样返回(不猜着合并未知结构);两边版本都未知时返回空状态而不是
 * 抛错 —— 同步链路上一个坏帧不该让本机词典功能挂掉。
 */
export function mergeSyncStates(
  a: VoiceDictionarySyncState,
  b: VoiceDictionarySyncState,
): VoiceDictionarySyncState {
  if (a.version !== VOICE_DICTIONARY_SYNC_VERSION || b.version !== VOICE_DICTIONARY_SYNC_VERSION) {
    if (a.version === VOICE_DICTIONARY_SYNC_VERSION) return a;
    if (b.version === VOICE_DICTIONARY_SYNC_VERSION) return b;
    return createEmptySyncState();
  }

  const records: Record<string, DictionaryRecord> = createDictionaryMap<DictionaryRecord>();
  for (const key of new Set([...Object.keys(a.records), ...Object.keys(b.records)])) {
    const left = a.records[key];
    const right = b.records[key];
    if (left && right) records[key] = mergeRecord(left, right);
    else records[key] = left ?? right;
  }

  const suppressed: Record<string, DictionarySuppression> = createDictionaryMap<DictionarySuppression>();
  for (const key of new Set([...Object.keys(a.suppressed), ...Object.keys(b.suppressed)])) {
    const left = a.suppressed[key];
    const right = b.suppressed[key];
    if (left && right) suppressed[key] = mergeSuppression(left, right);
    else suppressed[key] = left ?? right;
  }

  return { version: VOICE_DICTIONARY_SYNC_VERSION, records, suppressed };
}

/** 合并多份状态(设备上线时一次性收敛)。空数组返回空状态。 */
export function mergeAllSyncStates(
  states: ReadonlyArray<VoiceDictionarySyncState>,
): VoiceDictionarySyncState {
  return states.reduce<VoiceDictionarySyncState>(
    (acc, state) => mergeSyncStates(acc, state),
    createEmptySyncState(),
  );
}

/**
 * 状态的版本向量:每个 nodeId 在这份状态里出现过的最大时间戳。
 *
 * 用来判断两份状态之间的**包含关系**,而不是谁的时间戳大。单看最大 HLC 是错的:
 * 设备 A 在 HLC 100 加了 `foo`、设备 B 在 HLC 101 加了 `bar`,两份状态互不包含,
 * 但按最大值比会宣称 B 更新 —— 拿 B 当"完整答案"就漏掉了 `foo`。
 *
 * 向量对合并单调:`merge(a, b)` 的向量逐节点取 max,所以「A 的向量逐节点 ≥ B」
 * 等价于「A 已经见过 B 的全部事件」,这才是可以放心替代 B 的条件。
 */
export function buildStateVersionVector(state: VoiceDictionarySyncState): Record<string, string> {
  const vector: Record<string, string> = Object.create(null) as Record<string, string>;
  const observe = (stamp: HlcTimestamp | undefined): void => {
    if (!stamp) return;
    const nodeId = hlcNodeId(stamp);
    if (!nodeId) return;
    const current = vector[nodeId];
    if (current === undefined || compareHlc(stamp, current) > 0) vector[nodeId] = stamp;
  };
  for (const record of Object.values(state.records)) {
    for (const incarnation of Object.values(record.incarnations)) {
      observe(incarnation.tag);
      observe(incarnation.textStamp);
      for (const alias of Object.values(incarnation.aliases)) observe(alias.textStamp);
    }
    for (const stamp of Object.values(record.tombstones)) observe(stamp);
  }
  for (const suppression of Object.values(state.suppressed)) observe(suppression.stamp);
  // 原样返回无原型字典 —— 展开成 `{...vector}` 会把 Object.prototype 装回去,而
  // nodeId 是可以长成 `__proto__` / `constructor` 的(`isCanonicalHlc` 只要求它非空
  // 且不含 '.'),那样包含性比较会读到原型链上的值。JSON 序列化不受影响。
  return vector;
}

/**
 * `a` 是否已经见过 `b` 的全部事件(逐节点 ≥)。
 *
 * 互不包含(并发)时两边都返回 false —— 调用方必须为这种情况准备一条独立的决策,
 * 不能默认"那就选 a"。
 */
export function versionVectorDominates(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  for (const [nodeId, stamp] of Object.entries(b)) {
    const mine = a[nodeId];
    if (mine === undefined || compareHlc(mine, stamp) < 0) return false;
  }
  return true;
}

/** 状态里最大的 HLC,用于收到远端状态后抬高本地时钟(见 `observeHlc`)。 */
export function findMaxHlc(state: VoiceDictionarySyncState): HlcTimestamp | null {
  let max: HlcTimestamp | null = null;
  const observe = (stamp: HlcTimestamp | undefined): void => {
    if (!stamp) return;
    max = max === null ? stamp : maxHlc(max, stamp);
  };
  for (const record of Object.values(state.records)) {
    for (const incarnation of Object.values(record.incarnations)) {
      observe(incarnation.tag);
      observe(incarnation.textStamp);
      for (const alias of Object.values(incarnation.aliases)) observe(alias.textStamp);
    }
    for (const stamp of Object.values(record.tombstones)) observe(stamp);
  }
  for (const suppression of Object.values(state.suppressed)) observe(suppression.stamp);
  return max;
}
