/**
 * 降级回收:把「本机词典文件在 CRDT 之外被改过」这件事收回同步状态。
 *
 * 只有一种情况会触发 —— 用户装了旧版本客户端,旧版本直接读写词典文件、完全不知道
 * 同步状态的存在。升级回来之后,这份改动必须被认领,否则用户在旧版本里加的词会在
 * 下一次物化时被覆盖掉。
 *
 * ## 这条路径为什么必须小心
 *
 * 「比对文件与状态、把差异当成本地新增」正是最容易把词典搞成指数膨胀的写法:每次
 * 物化都会把合并进来的远端计数写进文件,如果它再被当成本地增量记一遍,同步一轮翻
 * 一倍。防线有三条:
 *
 *  1. **日常路径根本不走这里**。运行期的一切变更都直接调 mutate 原语写状态,文件只是
 *     状态的投影。本函数只在启动时发现投影对不上时跑一次。
 *  2. **只认领存在性,不认领频次**。降级期间涨的频次一律丢弃,以状态为准。频次是可
 *     重新积累的软信息,而错认频次是膨胀的直接来源 —— 两害相权,丢弃更安全。
 *  3. **删除判定基于上次物化写出去的主键集合**,而不是「状态里有、文件里没有」。被
 *     上限挤出物化的词条本来就不在文件里,拿状态直接比会把它们全部误判成用户删除。
 */

import { tickHlc, type HlcClock } from './hlc';
import { deleteTerms, promoteTermToEntry, seedTerm, type MutationResult } from './mutate';
import { dictionaryTermKey, normalizeDictionaryTermText } from './text';
import {
  hasDictionaryKey,
  withDictionaryKey,
  type DictionaryTermSource,
  type VoiceDictionarySyncState,
} from './types';

export interface LocalDictionarySnapshot {
  entries: ReadonlyArray<{
    text: string;
    source: DictionaryTermSource;
    frequency?: number;
    aliases?: ReadonlyArray<{ text: string; count?: number }>;
  }>;
  suppressedTexts: ReadonlyArray<string>;
  /**
   * 候选词(还在攒证据、用户不可见的中间态)。只认领新增,不认领删除 —— 候选词
   * 没有「上次物化」的基准可比,而丢一个候选词只会让它重新攒证据,代价极小。
   */
  candidates?: ReadonlyArray<{
    text: string;
    evidenceCount?: number;
    aliases?: ReadonlyArray<{ text: string; count?: number }>;
  }>;
}

export interface ReconcileInput {
  /** 当前词典文件里的内容(可能被旧版本改过)。 */
  snapshot: LocalDictionarySnapshot;
  /** 上一次由本模块物化写进该文件的词条主键集合。 */
  lastMaterializedKeys: ReadonlyArray<string>;
  /**
   * 是否允许在「只剩墓碑」的键上重建词条。默认 true。
   *
   * 降级回收要 true:投影是老客户端刚写下的新证据。sidecar 丢失后的恢复认领要
   * false —— 本机没有身份历史,越过墓碑重建会让别的设备上删掉的词复活。
   */
  allowTombstonedRevival?: boolean;
  nowMs: number;
}

export function reconcileFromLocalSnapshot(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: ReconcileInput,
): MutationResult {
  let nextState = state;
  let nextClock = clock;
  let changed = false;

  // 1. 抑制集合直接并集。旧版本删自动词条时会往文件里写抑制文本,这是比「猜哪条被
  //    删了」更可靠的信号,而且抑制是只增集合,并集不会丢信息。
  for (const rawText of input.snapshot.suppressedTexts ?? []) {
    const text = normalizeDictionaryTermText(rawText);
    const key = dictionaryTermKey(text);
    if (!key || hasDictionaryKey(nextState.suppressed, key)) continue;
    const result = deleteTerms(nextState, nextClock, {
      termKeys: [key],
      nowMs: input.nowMs,
      suppressAutomatic: true,
    });
    nextState = result.state;
    nextClock = result.clock;
    // 该词可能压根不在状态里(旧版本删掉后状态里也没有),deleteTerms 不会写抑制,
    // 这里补上,保证抑制意图不丢。
    if (!hasDictionaryKey(nextState.suppressed, key)) {
      const stamped = addSuppression(nextState, nextClock, key, text, input.nowMs);
      nextState = stamped.state;
      nextClock = stamped.clock;
    }
    changed = true;
  }

  const currentByKey = new Map<
    string,
    {
      text: string;
      source: DictionaryTermSource;
      frequency: number;
      aliases: ReadonlyArray<{ text: string; count?: number }>;
    }
  >();
  for (const entry of input.snapshot.entries) {
    const text = normalizeDictionaryTermText(entry.text);
    const key = dictionaryTermKey(text);
    if (!key) continue;
    currentByKey.set(key, {
      text,
      source: entry.source === 'manual' ? 'manual' : 'automatic',
      frequency: readCount(entry.frequency),
      aliases: entry.aliases ?? [],
    });
  }

  const previousKeys = new Set(
    input.lastMaterializedKeys.map((key) => dictionaryTermKey(key)).filter(Boolean),
  );

  // 2. 文件里有、上次没物化出去过 → 旧版本期间新增的词条(首次迁移时是全部词条),
  //    按它自己的来源认领。
  //
  //    **频次只在这条路径上认领**,而且 seedTerm 只对状态里完全不存在的词条生效:
  //    首次迁移时状态是空的,文件里的频次不可能包含任何远端计数,原样接管是安全的,
  //    而丢掉它会把用户长期积累的排序权重清零。已存在的词条一律不碰频次 —— 那时
  //    文件里的数字可能已经含有合并进来的远端计数,认领就是重复记账。
  for (const [key, entry] of currentByKey) {
    if (previousKeys.has(key)) continue;
    const result = seedTerm(nextState, nextClock, {
      text: entry.text,
      source: entry.source,
      stage: 'entry',
      count: entry.frequency,
      aliases: entry.aliases,
      nowMs: input.nowMs,
      allowTombstonedRevival: input.allowTombstonedRevival ?? true,
    });
    if (!result.changed) {
      // 该词条已经在状态里了(典型情形:sidecar 的 lastMaterializedKeys 丢失或损坏,
      // 于是所有词条都被当成「新增」)。存在性本来就已满足,这里必须什么都不做 ——
      // 早先的写法在这里补记一次学习事件,那会让每次启动都给全部词条 +1,反复重启
      // 就是一条缓慢但持续的膨胀曲线。
      //
      // 唯一的例外是阶段:状态里还是候选、而文件里已经是正式词条,说明老客户端在
      // 降级期间把它转正了。只提升阶段,不碰计数 —— 不补这一步,这次转正会在下次
      // 物化时被写回候选,用户在降级期间做的分类白做。
      const promoted = promoteTermToEntry(nextState, nextClock, { termKey: key, nowMs: input.nowMs });
      if (promoted.changed) {
        nextState = promoted.state;
        nextClock = promoted.clock;
        changed = true;
      }
      continue;
    }
    nextState = result.state;
    nextClock = result.clock;
    changed = true;
  }

  // 3. 候选词只认领新增:状态里已经有这个词(不论什么阶段)就跳过,避免把同一条
  //    候选反复记成新证据。
  for (const candidate of input.snapshot.candidates ?? []) {
    const text = normalizeDictionaryTermText(candidate.text);
    const key = dictionaryTermKey(text);
    if (!key || hasDictionaryKey(nextState.records, key) || currentByKey.has(key)) continue;
    const result = seedTerm(nextState, nextClock, {
      text,
      source: 'automatic',
      stage: 'candidate',
      count: readCount(candidate.evidenceCount),
      aliases: candidate.aliases,
      nowMs: input.nowMs,
    });
    nextState = result.state;
    nextClock = result.clock;
    changed = changed || result.changed;
  }

  // 4. 上次物化出去过、现在文件里没有 → 旧版本期间被删掉了。抑制已在第 1 步按文件
  //    的抑制列表处理过,这里不再重复写抑制,避免把「旧版本删手动词条」误升级成抑制。
  const removedKeys = [...previousKeys].filter((key) => !currentByKey.has(key));
  if (removedKeys.length > 0) {
    const result = deleteTerms(nextState, nextClock, {
      termKeys: removedKeys,
      nowMs: input.nowMs,
      suppressAutomatic: false,
    });
    nextState = result.state;
    nextClock = result.clock;
    changed = changed || result.changed;
  }

  return { state: nextState, clock: nextClock, changed };
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function addSuppression(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  key: string,
  text: string,
  nowMs: number,
): { state: VoiceDictionarySyncState; clock: HlcClock } {
  const ticked = tickHlc(clock, nowMs);
  return {
    state: {
      ...state,
      suppressed: withDictionaryKey(state.suppressed, key, { text, stamp: ticked.stamp }),
    },
    clock: ticked.clock,
  };
}
