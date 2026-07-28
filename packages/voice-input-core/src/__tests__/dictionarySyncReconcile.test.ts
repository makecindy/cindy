/**
 * 改写词条与降级回收。
 *
 * 回收是这套设计里唯一「拿文件反推变更」的路径,也是最容易把词典搞成指数膨胀的
 * 地方。这里除了功能正确性,重点钉住两件事:回收之后再同步不放大,以及被上限挤
 * 出物化的词条不会被误判成用户删除。
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
  reconcileFromLocalSnapshot,
  renameTerm,
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

function learn(target: Device, text: string, nowMs: number): void {
  const result = recordLearningEvent(target.state, target.clock, { text, stage: 'entry', nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function addManual(target: Device, text: string, nowMs: number): void {
  const result = addManualEntry(target.state, target.clock, { text, nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function snapshotOf(state: VoiceDictionarySyncState) {
  const materialized = materializeDictionary(state);
  return {
    entries: materialized.entries.map((entry) => ({ text: entry.text, source: entry.source })),
    suppressedTexts: materialized.suppressedTexts,
  };
}

function keysOf(state: VoiceDictionarySyncState): string[] {
  return materializeDictionary(state).entries.map((entry) => entry.text.toLowerCase());
}

describe('dictionary sync — 改写词条', () => {
  it('只改写法时保留频次与来源提升', () => {
    const a = device('a');
    learn(a, 'litellm', 1_000);
    learn(a, 'litellm', 1_100);

    const renamed = renameTerm(a.state, a.clock, { termKey: 'litellm', nextText: 'LiteLLM', nowMs: 2_000 });
    a.state = renamed.state;
    const entry = materializeDictionary(a.state).entries[0];
    expect(entry.text).toBe('LiteLLM');
    expect(entry.frequency).toBe(2);
    expect(entry.source).toBe('manual');
  });

  it('改成另一个词时把频次与别名一并搬过去 —— 纠正写法不该丢掉学到的东西', () => {
    const a = device('a');
    for (let index = 0; index < 4; index += 1) {
      const result = recordLearningEvent(a.state, a.clock, {
        text: 'litellm',
        aliases: ['light LLM'],
        stage: 'entry',
        nowMs: 1_000 + index,
      });
      a.state = result.state;
      a.clock = result.clock;
    }

    const renamed = renameTerm(a.state, a.clock, {
      termKey: 'litellm',
      nextText: 'LiteLLM Proxy',
      nowMs: 2_000,
    });
    a.state = renamed.state;

    const entry = materializeDictionary(a.state).entries[0];
    expect(entry.text).toBe('LiteLLM Proxy');
    expect(entry.frequency).toBe(4);
    expect(entry.aliases.map((alias) => [alias.text, alias.count])).toEqual([['light LLM', 4]]);
  });

  it('改成另一个词等价于删除加新增,且不写抑制', () => {
    const a = device('a');
    learn(a, 'Orca', 1_000);
    const renamed = renameTerm(a.state, a.clock, { termKey: 'orca', nextText: 'Orca Team', nowMs: 2_000 });
    a.state = renamed.state;
    a.clock = renamed.clock;

    expect(keysOf(a.state)).toEqual(['orca team']);
    // 改名不是拒绝:抑制集合必须干净,否则新写法日后被自动学习到会被自己挡住。
    expect(materializeDictionary(a.state).suppressedTexts).toEqual([]);
    learn(a, 'Orca', 3_000);
    expect(keysOf(a.state).sort()).toEqual(['orca', 'orca team']);
  });

  it('改写结果跨设备收敛', () => {
    const a = device('a');
    const b = device('b', 5_000);
    learn(a, 'litellm', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    const renamed = renameTerm(a.state, a.clock, { termKey: 'litellm', nextText: 'LiteLLM', nowMs: 2_000 });
    a.state = renamed.state;

    expect(materializeDictionary(mergeSyncStates(a.state, b.state))).toEqual(
      materializeDictionary(mergeSyncStates(b.state, a.state)),
    );
    expect(materializeDictionary(mergeSyncStates(b.state, a.state)).entries[0].text).toBe('LiteLLM');
  });
});

describe('dictionary sync — 首次迁移保留频次', () => {
  it('存量词典的频次与候选证据数被原样接管,不会被清零', () => {
    // 首次迁移:状态是空的,文件里的数字全是本机长期积累的,原样接管才对。
    const result = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: [
          { text: 'Claude code', source: 'automatic', frequency: 4 },
          { text: 'Fable 5', source: 'automatic', frequency: 3 },
          { text: 'Cindy', source: 'manual', frequency: 2 },
        ],
        suppressedTexts: [],
        candidates: [{ text: 'Bug', evidenceCount: 2 }, { text: 'invoice', evidenceCount: 1 }],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });

    const materialized = materializeDictionary(result.state);
    expect(materialized.entries.map((entry) => [entry.text, entry.frequency])).toEqual([
      ['Claude code', 4],
      ['Fable 5', 3],
      ['Cindy', 2],
    ]);
    expect(materialized.candidates.map((item) => [item.text, item.evidenceCount])).toEqual([
      ['Bug', 2],
      ['invoice', 1],
    ]);
  });

  it('别名与其次数一并接管 —— 它们是纠错能力的主体,丢了词典就白学了', () => {
    const result = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: [
          {
            text: 'Vibe Coding',
            source: 'automatic',
            frequency: 4,
            aliases: [
              { text: 'web coding', count: 3 },
              { text: '外部 coding', count: 1 },
            ],
          },
        ],
        suppressedTexts: [],
        candidates: [
          { text: 'Orca', evidenceCount: 2, aliases: [{ text: 'okra', count: 2 }] },
        ],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });

    const materialized = materializeDictionary(result.state);
    const entry = materialized.entries[0];
    expect(entry.frequency).toBe(4);
    expect(entry.aliases.map((alias) => [alias.text, alias.count])).toEqual([
      ['web coding', 3],
      ['外部 coding', 1],
    ]);
    expect(materialized.candidates[0].aliases.map((alias) => alias.text)).toEqual(['okra']);
  });

  it('迁移进来的别名可以继续累积,并跨设备合并', () => {
    const migrate = (nodeId: string) => reconcileFromLocalSnapshot(
      createEmptySyncState(),
      createHlcClock(nodeId, 1_000),
      {
        snapshot: {
          entries: [{
            text: 'Vibe Coding',
            source: 'automatic',
            frequency: 2,
            aliases: [{ text: 'web coding', count: 2 }],
          }],
          suppressedTexts: [],
        },
        lastMaterializedKeys: [],
        nowMs: 2_000,
      },
    );

    const a = migrate('a');
    const bumped = recordLearningEvent(a.state, a.clock, {
      text: 'Vibe Coding',
      aliases: ['web coding'],
      stage: 'entry',
      nowMs: 3_000,
    });
    expect(materializeDictionary(bumped.state).entries[0].aliases[0].count).toBe(3);

    // 两台各自迁移同一份词典再合并:别名取并集,计数不会因合并翻倍。
    const b = migrate('b');
    const merged = mergeSyncStates(bumped.state, b.state);
    const aliases = materializeDictionary(merged).entries[0].aliases;
    expect(aliases).toHaveLength(1);
    expect(aliases[0].text).toBe('web coding');
  });

  it('缺失或异常的频次退回 1,不产生 0 或负数', () => {
    const result = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: [
          { text: 'NoFreq', source: 'manual' },
          { text: 'Negative', source: 'manual', frequency: -3 },
        ],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });
    for (const entry of materializeDictionary(result.state).entries) {
      expect(entry.frequency).toBe(1);
    }
  });

  it('已存在的词条不会被文件里的频次覆盖 —— 那可能含有合并进来的远端计数', () => {
    const a = device('a');
    const b = device('b', 5_000);
    for (let index = 0; index < 3; index += 1) learn(a, 'Cindy', 1_000 + index);
    b.state = mergeSyncStates(b.state, a.state);
    for (let index = 0; index < 2; index += 1) learn(b, 'Cindy', 6_000 + index);
    a.state = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(5);

    // 文件里写着 5(上次物化的结果)。即使把它当成「新增」喂回来,也不能再记一遍。
    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: {
        entries: [{ text: 'Cindy', source: 'automatic', frequency: 5 }],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 9_000,
    });
    expect(materializeDictionary(result.state).entries[0].frequency).toBe(5);
  });

  it('迁移进来的频次可以继续正常增长与合并', () => {
    const migrated = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: [{ text: 'Cindy', source: 'automatic', frequency: 4 }],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });
    const a = { state: migrated.state, clock: migrated.clock };
    learn(a, 'Cindy', 3_000);
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(5);

    // 另一台设备各自迁移了同一份词典再学一次:两边各记各的桶,合并后求和。
    const migratedB = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('b', 1_000), {
      snapshot: {
        entries: [{ text: 'Cindy', source: 'automatic', frequency: 4 }],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });
    const merged = mergeSyncStates(a.state, migratedB.state);
    expect(materializeDictionary(merged).entries[0].frequency).toBe(9);
    // 反复合并不再增长。
    expect(
      materializeDictionary(mergeSyncStates(merged, migratedB.state)).entries[0].frequency,
    ).toBe(9);
  });
});

describe('dictionary sync — 降级回收', () => {
  it('认领旧版本期间新增的词条,手动与自动来源分别对待', () => {
    const a = device('a');
    learn(a, 'Cindy', 1_000);
    const lastKeys = keysOf(a.state);

    // 旧版本在文件里加了两条:一条手动、一条自动学习。
    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: {
        entries: [
          { text: 'Cindy', source: 'automatic' },
          { text: 'Orca', source: 'manual' },
          { text: 'device-link', source: 'automatic' },
        ],
        suppressedTexts: [],
      },
      lastMaterializedKeys: lastKeys,
      nowMs: 2_000,
    });
    a.state = result.state;
    a.clock = result.clock;

    const materialized = materializeDictionary(a.state);
    expect(materialized.entries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'Orca',
      'device-link',
    ]);
    expect(materialized.entries.find((entry) => entry.text === 'Orca')?.source).toBe('manual');
    expect(materialized.entries.find((entry) => entry.text === 'device-link')?.source).toBe('automatic');
  });

  it('认领旧版本期间的删除,并把文件里的抑制列表并回状态', () => {
    const a = device('a');
    learn(a, 'Cindy', 1_000);
    learn(a, 'Orca', 1_100);
    const lastKeys = keysOf(a.state);

    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: {
        entries: [{ text: 'Cindy', source: 'automatic' }],
        suppressedTexts: ['Orca'],
      },
      lastMaterializedKeys: lastKeys,
      nowMs: 2_000,
    });
    a.state = result.state;
    a.clock = result.clock;

    expect(keysOf(a.state)).toEqual(['cindy']);
    expect(materializeDictionary(a.state).suppressedTexts).toEqual(['Orca']);
    // 抑制生效:后台学习不会把它加回来。
    learn(a, 'Orca', 3_000);
    expect(keysOf(a.state)).toEqual(['cindy']);
  });

  it('被上限挤出物化的词条不会被误判成用户删除', () => {
    const a = device('a');
    for (let index = 0; index < 4; index += 1) {
      for (let times = 0; times <= index; times += 1) learn(a, `term-${index}`, 1_000 + index * 10 + times);
    }
    const limits = { ...DEFAULT_MATERIALIZE_LIMITS, maxEntries: 2 };
    const visible = materializeDictionary(a.state, limits);
    expect(visible.entries).toHaveLength(2);

    // 文件里只有物化出去的那两条 —— 回收必须以「上次物化的主键」为准,
    // 否则被截断的另外两条会被当成删除,墓碑一广播就是全网批量误删。
    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: {
        entries: visible.entries.map((entry) => ({ text: entry.text, source: entry.source })),
        suppressedTexts: [],
      },
      lastMaterializedKeys: visible.entries.map((entry) => entry.text.toLowerCase()),
      nowMs: 5_000,
    });

    expect(materializeDictionary(result.state).entries).toHaveLength(4);
    for (const record of Object.values(result.state.records)) {
      expect(Object.keys(record.tombstones)).toEqual([]);
    }
  });

  it('文件与状态一致时回收是空操作', () => {
    const a = device('a');
    learn(a, 'Cindy', 1_000);
    addManual(a, 'Orca', 1_100);

    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: snapshotOf(a.state),
      lastMaterializedKeys: keysOf(a.state),
      nowMs: 2_000,
    });
    expect(result.changed).toBe(false);
    expect(materializeDictionary(result.state)).toEqual(materializeDictionary(a.state));
  });

  it('回收之后再同步不会放大频次', () => {
    const a = device('a');
    const b = device('b', 5_000);
    for (let index = 0; index < 3; index += 1) learn(a, 'Cindy', 1_000 + index);
    b.state = mergeSyncStates(b.state, a.state);
    for (let index = 0; index < 2; index += 1) learn(b, 'Cindy', 6_000 + index);

    // A 合并了 B 的状态并物化(此时文件里的频次是 5),随后跑一次回收。
    a.state = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(5);

    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: snapshotOf(a.state),
      lastMaterializedKeys: keysOf(a.state),
      nowMs: 7_000,
    });
    a.state = result.state;
    a.clock = result.clock;

    // 合并进来的远端计数不能被当成本地增量再记一遍。
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(5);
    for (let round = 0; round < 5; round += 1) {
      a.state = mergeSyncStates(a.state, b.state);
      b.state = mergeSyncStates(b.state, a.state);
    }
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(5);
    expect(materializeDictionary(b.state).entries[0].frequency).toBe(5);
  });

  it('回收产生的删除会传播到其它设备', () => {
    const a = device('a');
    const b = device('b', 5_000);
    addManual(a, 'Cindy', 1_000);
    b.state = mergeSyncStates(b.state, a.state);

    const result = reconcileFromLocalSnapshot(a.state, a.clock, {
      snapshot: { entries: [], suppressedTexts: [] },
      lastMaterializedKeys: ['cindy'],
      nowMs: 2_000,
    });
    a.state = result.state;

    b.state = mergeSyncStates(b.state, a.state);
    expect(keysOf(b.state)).toEqual([]);
  });
});

describe('dictionary sync — 删除抑制开关', () => {
  it('suppressAutomatic 为 false 时不写抑制集合', () => {
    const a = device('a');
    learn(a, 'Orca', 1_000);
    const result = deleteTerms(a.state, a.clock, {
      termKeys: ['orca'],
      nowMs: 2_000,
      suppressAutomatic: false,
    });
    expect(materializeDictionary(result.state).entries).toEqual([]);
    expect(materializeDictionary(result.state).suppressedTexts).toEqual([]);
  });
});
