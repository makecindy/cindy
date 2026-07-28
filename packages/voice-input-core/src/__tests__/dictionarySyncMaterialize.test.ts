/**
 * 物化的确定性与上限行为。
 *
 * 上限裁决收在物化里而不是交给下游 normalize,是为了两件事:全网算出同一份结果,
 * 以及**被挤出上限的词条绝不生成墓碑**。后者是一个真实的自伤风险:截断产生的
 * 「词条消失」如果被回收逻辑当成用户删除,就会广播墓碑批量误删全网词条。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MATERIALIZE_LIMITS,
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  materializeDictionary,
  mergeSyncStates,
  recordLearningEvent,
  type HlcClock,
  type VoiceDictionarySyncState,
} from '../dictionary-sync';

interface Device {
  state: VoiceDictionarySyncState;
  clock: HlcClock;
}

function device(nodeId: string, wallMs = 1_000): Device {
  return { state: createEmptySyncState(), clock: createHlcClock(nodeId, wallMs) };
}

function learn(target: Device, text: string, nowMs: number, aliases: string[] = []): void {
  const result = recordLearningEvent(target.state, target.clock, {
    text,
    aliases,
    stage: 'entry',
    nowMs,
  });
  target.state = result.state;
  target.clock = result.clock;
}

describe('dictionary sync — 物化上限', () => {
  it('超出上限的词条只是不物化,不产生墓碑,状态里仍然保留', () => {
    const a = device('a');
    for (let index = 0; index < 6; index += 1) {
      // 频次递减,确保裁决顺序确定。
      for (let times = 0; times <= index; times += 1) learn(a, `term-${index}`, 1_000 + index * 10 + times);
    }

    const limits = { ...DEFAULT_MATERIALIZE_LIMITS, maxEntries: 3 };
    const materialized = materializeDictionary(a.state, limits);
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['term-5', 'term-4', 'term-3']);

    // 状态里 6 条都在,而且一个墓碑都没有。
    expect(Object.keys(a.state.records)).toHaveLength(6);
    for (const record of Object.values(a.state.records)) {
      expect(Object.keys(record.tombstones)).toEqual([]);
    }

    // 频次涨回来就重新出现,不需要任何恢复逻辑。
    for (let times = 0; times < 5; times += 1) learn(a, 'term-0', 2_000 + times);
    expect(materializeDictionary(a.state, limits).entries.map((entry) => entry.text)).toContain('term-0');
  });

  it('上限裁决在不同设备上结果一致,与词条写入顺序无关', () => {
    const a = device('a');
    const b = device('b', 5_000);
    const terms = ['alpha', 'bravo', 'charlie', 'delta'];
    terms.forEach((term, index) => {
      for (let times = 0; times <= index; times += 1) learn(a, term, 1_000 + index * 10 + times);
    });
    [...terms].reverse().forEach((term, index) => {
      learn(b, term, 6_000 + index);
    });

    const limits = { ...DEFAULT_MATERIALIZE_LIMITS, maxEntries: 2 };
    const merged1 = mergeSyncStates(a.state, b.state);
    const merged2 = mergeSyncStates(b.state, a.state);
    expect(materializeDictionary(merged1, limits)).toEqual(materializeDictionary(merged2, limits));
  });

  it('频次并列时按主键做确定性兜底排序', () => {
    const a = device('a');
    // 同一毫秒、同一频次:排序只能靠主键兜底,否则两台设备可能截出不同结果。
    learn(a, 'zulu', 1_000);
    learn(a, 'alpha', 1_000);
    const limits = { ...DEFAULT_MATERIALIZE_LIMITS, maxEntries: 1 };
    expect(materializeDictionary(a.state, limits).entries[0].text).toBe('alpha');
  });

  it('别名超过上限时按计数截断,并保持跨设备一致', () => {
    const a = device('a');
    const aliases = Array.from({ length: 12 }, (_, index) => `alias-${index}`);
    // 让 alias-0 出现次数最多,其余递减。
    aliases.forEach((alias, index) => {
      for (let times = 0; times < aliases.length - index; times += 1) {
        learn(a, 'Cindy', 1_000 + index * 20 + times, [alias]);
      }
    });
    const materialized = materializeDictionary(a.state);
    expect(materialized.entries[0].aliases).toHaveLength(DEFAULT_MATERIALIZE_LIMITS.maxAliases);
    expect(materialized.entries[0].aliases[0].text).toBe('alias-0');
    const counts = materialized.entries[0].aliases.map((alias) => alias.count);
    expect([...counts].sort((x, y) => y - x)).toEqual(counts);
  });
});

describe('dictionary sync — 物化语义', () => {
  it('抑制只压制自动词条,手动词条照常显示', () => {
    const a = device('a');
    learn(a, 'Orca', 1_000);
    const deleted = deleteTerms(a.state, a.clock, { termKeys: ['orca'], nowMs: 2_000 });
    a.state = deleted.state;
    a.clock = deleted.clock;
    expect(materializeDictionary(a.state).suppressedTexts).toEqual(['Orca']);

    // 抑制仍在,但用户手动把它加了回来 —— 手动词条不受抑制影响。
    const added = addManualEntry(a.state, a.clock, { text: 'Orca', nowMs: 3_000 });
    a.state = added.state;
    const materialized = materializeDictionary(a.state);
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['Orca']);
    expect(materialized.suppressedTexts).toEqual(['Orca']);
  });

  it('同一个词只出现在 entries 或 candidates 之一', () => {
    const a = device('a');
    const candidate = recordLearningEvent(a.state, a.clock, {
      text: 'device-link',
      stage: 'candidate',
      nowMs: 1_000,
    });
    a.state = candidate.state;
    a.clock = candidate.clock;
    expect(materializeDictionary(a.state).candidates.map((item) => item.text)).toEqual(['device-link']);
    expect(materializeDictionary(a.state).entries).toEqual([]);

    const promoted = recordLearningEvent(a.state, a.clock, {
      text: 'device-link',
      stage: 'entry',
      nowMs: 1_100,
    });
    a.state = promoted.state;
    expect(materializeDictionary(a.state).candidates).toEqual([]);
    expect(materializeDictionary(a.state).entries.map((item) => item.text)).toEqual(['device-link']);
  });

  it('一端手动确认过的词条,合并后来源保持 manual', () => {
    const a = device('a');
    const b = device('b', 4_000);
    learn(a, 'Cindy', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    const added = addManualEntry(b.state, b.clock, { text: 'Cindy', nowMs: 5_000 });
    b.state = added.state;

    // 之后 A 继续自动学习,也不会把来源退回 automatic。
    learn(a, 'Cindy', 6_000);
    const merged = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(merged).entries[0].source).toBe('manual');
  });

  it('展示文本取最新写法,且两端一致', () => {
    const a = device('a');
    const b = device('b', 4_000);
    learn(a, 'litellm', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    const renamed = addManualEntry(b.state, b.clock, { text: 'LiteLLM', nowMs: 5_000 });
    b.state = renamed.state;

    const forward = materializeDictionary(mergeSyncStates(a.state, b.state));
    const backward = materializeDictionary(mergeSyncStates(b.state, a.state));
    expect(forward.entries[0].text).toBe('LiteLLM');
    expect(forward).toEqual(backward);
  });
});
