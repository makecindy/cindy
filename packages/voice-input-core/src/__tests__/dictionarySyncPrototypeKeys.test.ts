/**
 * 以 `Object.prototype` 成员名为文本的词条。
 *
 * `constructor`、`toString`、`valueOf`、`__proto__` 都是完全合法的技术术语,用户
 * 完全可能把它们加进词典。而词条主键直接当对象键用,只要哪里用了 `in` 或裸取值,
 * 这些词就会命中原型链:被当成"已存在"而静默丢弃,或者把一个继承来的函数当成
 * 词条记录传下去。
 *
 * 这类 bug 平时跑不出来 —— 只有真有用户加了这么一个词才炸,所以必须有测试守着。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOMBSTONE_TTL_MS,
  addManualEntry,
  buildStateVersionVector,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  gcTombstones,
  materializeDictionary,
  mergeSyncStates,
  recordLearningEvent,
  reconcileFromLocalSnapshot,
  versionVectorDominates,
  type HlcClock,
  type VoiceDictionarySyncState,
} from '../dictionary-sync';

/** 全是 Object.prototype 上真实存在的成员名。 */
const PROTOTYPE_NAMES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'isPrototypeOf',
  'propertyIsEnumerable',
];

interface Device {
  state: VoiceDictionarySyncState;
  clock: HlcClock;
}

function device(nodeId: string, wallMs = 1_000): Device {
  return { state: createEmptySyncState(), clock: createHlcClock(nodeId, wallMs) };
}

describe('原型链成员名作为词条', () => {
  it('能被手动添加,并且真的出现在词典里', () => {
    const a = device('a');
    for (const [index, name] of PROTOTYPE_NAMES.entries()) {
      const result = addManualEntry(a.state, a.clock, { text: name, nowMs: 1_000 + index });
      expect(result.changed).toBe(true);
      a.state = result.state;
      a.clock = result.clock;
    }
    const texts = materializeDictionary(a.state).entries.map((entry) => entry.text).sort();
    expect(texts).toEqual([...PROTOTYPE_NAMES].sort());
  });

  it('能被自动学习记录,频次正常累积', () => {
    const a = device('a');
    for (let round = 0; round < 3; round += 1) {
      const result = recordLearningEvent(a.state, a.clock, {
        text: 'constructor',
        aliases: ['construct or'],
        stage: 'entry',
        nowMs: 1_000 + round,
      });
      expect(result.changed).toBe(true);
      a.state = result.state;
      a.clock = result.clock;
    }
    const entry = materializeDictionary(a.state).entries[0];
    expect(entry.text).toBe('constructor');
    expect(entry.frequency).toBe(3);
  });

  it('能被删除,并且抑制集合对它生效', () => {
    const a = device('a');
    const learned = recordLearningEvent(a.state, a.clock, {
      text: 'toString',
      aliases: ['to string'],
      stage: 'entry',
      nowMs: 1_000,
    });
    a.state = learned.state;
    a.clock = learned.clock;

    const removed = deleteTerms(a.state, a.clock, { termKeys: ['tostring'], nowMs: 2_000 });
    a.state = removed.state;
    a.clock = removed.clock;
    expect(materializeDictionary(a.state).entries).toEqual([]);
    expect(materializeDictionary(a.state).suppressedTexts).toEqual(['toString']);

    // 抑制生效:后台学习不会把它加回来。
    const relearn = recordLearningEvent(a.state, a.clock, {
      text: 'toString',
      aliases: ['to string'],
      stage: 'entry',
      nowMs: 3_000,
    });
    expect(materializeDictionary(relearn.state).entries).toEqual([]);
  });

  it('跨设备合并不丢失', () => {
    const a = device('a');
    const b = device('b', 5_000);
    const learnedA = recordLearningEvent(a.state, a.clock, {
      text: '__proto__',
      aliases: ['proto'],
      stage: 'entry',
      nowMs: 1_000,
    });
    a.state = learnedA.state;
    const learnedB = recordLearningEvent(b.state, b.clock, {
      text: 'valueOf',
      aliases: ['value of'],
      stage: 'entry',
      nowMs: 6_000,
    });
    b.state = learnedB.state;

    const merged = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(merged).entries.map((entry) => entry.text).sort()).toEqual([
      '__proto__',
      'valueOf',
    ]);
    // 合并可交换性对这些键同样成立。
    expect(materializeDictionary(mergeSyncStates(b.state, a.state))).toEqual(
      materializeDictionary(merged),
    );
  });

  it('墓碑回收不会丢掉存活的原型名词条', () => {
    // gcTombstones 重建 records;用普通 {} 的话,给 `__proto__` 赋值会走原型 setter,
    // 这条合法词条会被静默丢掉,而且这个丢失还会被持久化并同步出去。
    const a = device('a');
    const kept = addManualEntry(a.state, a.clock, { text: '__proto__', nowMs: 1_000 });
    a.state = kept.state;
    a.clock = kept.clock;
    const doomed = addManualEntry(a.state, a.clock, { text: 'Orca', nowMs: 1_100 });
    a.state = doomed.state;
    a.clock = doomed.clock;
    const removed = deleteTerms(a.state, a.clock, { termKeys: ['orca'], nowMs: 2_000 });
    a.state = removed.state;

    const collected = gcTombstones(a.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    expect(materializeDictionary(collected).entries.map((entry) => entry.text)).toEqual(['__proto__']);
  });

  it('首次迁移时不会被当成「已存在」而静默丢弃', () => {
    // 这正是原型链 bug 的杀伤面:seedTerm 用 `key in records` 判断存在性时,
    // 空状态下 'constructor' in {} 恒为 true,整条词就被跳过了。
    const result = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: PROTOTYPE_NAMES.map((name, index) => ({
          text: name,
          source: 'manual' as const,
          frequency: index + 2,
        })),
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });

    const materialized = materializeDictionary(result.state);
    expect(materialized.entries.map((entry) => entry.text).sort()).toEqual(
      [...PROTOTYPE_NAMES].sort(),
    );
    // 频次也得原样接管,不能退回 1。
    for (const [index, name] of PROTOTYPE_NAMES.entries()) {
      const entry = materialized.entries.find((item) => item.text === name);
      expect(`${name}=${entry?.frequency}`).toBe(`${name}=${index + 2}`);
    }
  });
});

describe('版本向量的键也来自不可信输入', () => {
  it('返回的是无原型字典 —— nodeId 叫 __proto__ 也不会读到原型链上的值', () => {
    const state = addManualEntry(createEmptySyncState(), createHlcClock('__proto__', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    }).state;

    const vector = buildStateVersionVector(state);
    expect(Object.getPrototypeOf(vector)).toBeNull();
    expect(vector['__proto__']).toBeTypeOf('string');
    // 不存在的原型名键必须是 undefined,否则包含性比较会拿函数去比大小。
    expect(vector['constructor']).toBeUndefined();
    expect(vector['toString']).toBeUndefined();

    // 包含性比较在这种 nodeId 下仍然自洽。
    expect(versionVectorDominates(vector, vector)).toBe(true);
    expect(versionVectorDominates(buildStateVersionVector(createEmptySyncState()), vector)).toBe(false);

    // 序列化往返保真(投影要经隧道发给手机):`JSON.parse` 把 `__proto__` 建成
    // own property 而不是走原型 setter,所以这个 nodeId 不会在传输中丢掉。
    const roundTripped = JSON.parse(JSON.stringify(vector)) as Record<string, string>;
    expect(Object.keys(roundTripped)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')?.value).toBe(
      vector['__proto__'],
    );
  });
});
