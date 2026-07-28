/**
 * 把 CRDT 状态物化成词典设置里的三件套(entries / candidates / suppressed)。
 *
 * 物化必须是**确定性**的:同一份状态在任何设备上算出的结果逐字节相同。上限裁决
 * 因此收在这里,而不是交给下游的 normalize 去截断 —— 各设备各截各的会让「谁被
 * 截掉」不一致,而截断产生的「词条消失」一旦被回收逻辑误判成用户删除,就会生成
 * 墓碑广播出去,批量误删全网词条。
 *
 * 结论:**被上限挤出去的词条只是不物化,永远不生成墓碑**,它们留在状态里休眠,
 * 频次涨回来自然会重新出现。
 */

import { compareHlc } from './hlc';
import {
  hasDictionaryKey,
  listLiveIncarnations,
  readCounterTotal,
  type DictionaryIncarnation,
  type DictionaryTermSource,
  type VoiceDictionarySyncState,
} from './types';

/** 与 desktop `voiceInputData.ts` 的同名常量保持一致。 */
export const DEFAULT_MATERIALIZE_LIMITS = {
  maxEntries: 1_000,
  maxCandidates: 200,
  maxAliases: 8,
} as const;

export interface MaterializeLimits {
  maxEntries: number;
  maxCandidates: number;
  maxAliases: number;
}

export interface MaterializedAlias {
  text: string;
  count: number;
  lastSeenAt: number;
}

export interface MaterializedEntry {
  id: string;
  text: string;
  source: DictionaryTermSource;
  frequency: number;
  aliases: MaterializedAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface MaterializedCandidate {
  text: string;
  evidenceCount: number;
  aliases: MaterializedAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface MaterializedDictionary {
  entries: MaterializedEntry[];
  candidates: MaterializedCandidate[];
  suppressedTexts: string[];
}

/**
 * 物化出的词条 id。
 *
 * 由归一化主键确定性派生,而不是沿用某个化身的 tag:UI 拿 id 发起删除,id 必须
 * 在「同一个词的化身来来去去」的过程中保持稳定,并且全网一致(否则同一条词在两
 * 台设备上 React key 不同、删除请求也对不上)。
 */
export const MATERIALIZED_ID_PREFIX = 'dict-sync-';

export function materializedEntryId(termKey: string): string {
  return `${MATERIALIZED_ID_PREFIX}${termKey}`;
}

/** 跨存活化身取展示文本:LWW,时间戳相同时按化身 tag 兜底,保证全网一致。 */
export function pickDisplayText(live: ReadonlyArray<DictionaryIncarnation>): string {
  return live.reduce((best, item) => {
    const order = compareHlc(item.textStamp, best.textStamp);
    if (order > 0) return item;
    if (order < 0) return best;
    return item.tag > best.tag ? item : best;
  }, live[0]).text;
}

export function materializeDictionary(
  state: VoiceDictionarySyncState,
  limits: MaterializeLimits = DEFAULT_MATERIALIZE_LIMITS,
): MaterializedDictionary {
  const entries: Array<MaterializedEntry & { key: string }> = [];
  const candidates: Array<MaterializedCandidate & { key: string }> = [];

  for (const [key, record] of Object.entries(state.records)) {
    const live = listLiveIncarnations(record);
    if (live.length === 0) continue;

    const source: DictionaryTermSource = live.some((item) => item.source === 'manual')
      ? 'manual'
      : 'automatic';
    // 抑制只压制自动学习的产物。用户手动添加过的同名词条不受影响 —— 与 desktop
    // 单机语义一致(手动词条的删除本来就不写抑制集合)。
    if (source === 'automatic' && hasDictionaryKey(state.suppressed, key)) continue;

    const stage = live.some((item) => item.stage === 'entry') ? 'entry' : 'candidate';
    const total = Math.max(1, live.reduce((sum, item) => sum + readCounterTotal(item.counters), 0));
    const text = pickDisplayText(live);
    const aliases = mergeLiveAliases(live, limits.maxAliases);
    const createdAt = live.reduce((min, item) => Math.min(min, item.createdAt), live[0].createdAt);
    const updatedAt = live.reduce((max, item) => Math.max(max, item.updatedAt), live[0].updatedAt);

    if (stage === 'entry') {
      entries.push({
        key,
        id: materializedEntryId(key),
        text,
        source,
        frequency: total,
        aliases,
        createdAt,
        updatedAt,
      });
    } else {
      candidates.push({ key, text, evidenceCount: total, aliases, createdAt, updatedAt });
    }
  }

  return {
    entries: sortAndCap(
      entries,
      (item) => item.frequency,
      limits.maxEntries,
      (item) => (item.source === 'manual' ? 1 : 0),
    ).map(stripKey),
    candidates: sortAndCap(candidates, (item) => item.evidenceCount, limits.maxCandidates).map(stripKey),
    suppressedTexts: Object.keys(state.suppressed)
      .sort()
      .map((key) => state.suppressed[key].text),
  };
}

/**
 * 跨存活化身合并别名。
 *
 * 同一别名在不同化身上的计数**相加** —— 它们是不同化身各自观察到的独立事件。
 * (化身内部按节点分桶取 max 已经在合并阶段做完,这里不会重复计入同一事件。)
 */
function mergeLiveAliases(
  live: ReadonlyArray<DictionaryIncarnation>,
  maxAliases: number,
): MaterializedAlias[] {
  const totals = new Map<string, { text: string; textStamp: string; count: number; lastSeenAt: number }>();
  for (const incarnation of live) {
    for (const [aliasKey, alias] of Object.entries(incarnation.aliases)) {
      const count = readCounterTotal(alias.counters);
      const existing = totals.get(aliasKey);
      if (!existing) {
        totals.set(aliasKey, {
          text: alias.text,
          textStamp: alias.textStamp,
          count,
          lastSeenAt: alias.lastSeenAt,
        });
        continue;
      }
      const newerText = compareHlc(alias.textStamp, existing.textStamp) > 0;
      totals.set(aliasKey, {
        text: newerText ? alias.text : existing.text,
        textStamp: newerText ? alias.textStamp : existing.textStamp,
        count: existing.count + count,
        lastSeenAt: Math.max(existing.lastSeenAt, alias.lastSeenAt),
      });
    }
  }

  return [...totals.entries()]
    .filter(([, alias]) => alias.count > 0)
    // 排序尾键用别名主键:desktop 现有排序(count desc, lastSeenAt desc)在并列时
    // 结果依赖数组原始顺序,跨设备不一致。这里补确定性尾键。
    .sort(([keyA, a], [keyB, b]) => b.count - a.count || b.lastSeenAt - a.lastSeenAt || (keyA < keyB ? -1 : 1))
    .slice(0, maxAliases)
    .map(([, alias]) => ({ text: alias.text, count: alias.count, lastSeenAt: alias.lastSeenAt }));
}

/**
 * 排序并裁到上限。
 *
 * `readRank`(数值大者优先)只决定**谁被裁掉**,不影响最终展示顺序:多设备合并后
 * 存活词条可能超过上限,纯按频次裁会让用户手动加的低频词被自动学来的高频词挤掉 ——
 * 那个词在所有设备上一起消失,而且它频次本来就低,再也涨不回来。手动词条是用户的
 * 显式意图,必须先保下来;保下来之后仍按频次展示。
 */
function sortAndCap<T extends { key: string; updatedAt: number }>(
  items: T[],
  readWeight: (item: T) => number,
  limit: number,
  readRank: (item: T) => number = () => 0,
): T[] {
  const byWeight = (a: T, b: T): number =>
    readWeight(b) - readWeight(a) || b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1);
  const capped = Math.max(0, limit);
  const ordered = [...items].sort(byWeight);
  if (ordered.length <= capped) return ordered;
  const survivors = new Set(
    [...ordered]
      .sort((a, b) => readRank(b) - readRank(a) || byWeight(a, b))
      .slice(0, capped)
      .map((item) => item.key),
  );
  return ordered.filter((item) => survivors.has(item.key));
}

function stripKey<T extends { key: string }>(item: T): Omit<T, 'key'> {
  const rest = { ...item } as Partial<T>;
  delete rest.key;
  return rest as Omit<T, 'key'>;
}
