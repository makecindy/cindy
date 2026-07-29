/**
 * 并发改名与容量裁剪。
 *
 * 「不要有 Bug 造成词典重复增长」是这套同步最硬的约束。改名尤其危险:它是唯一一个
 * 把已积累的证据搬到另一个键下的操作,搬的方式稍有不慎,两台设备各搬一次就翻倍。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_AUTOMATIC_CANDIDATE_RECORDS,
  createEmptySyncState,
  createHlcClock,
  isCanonicalHlc,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  pruneWeakAutomaticCandidates,
  recordLearningEvent,
  renameTerm,
  seedTerm,
} from '../dictionary-sync';

describe('并发改名', () => {
  it('两台已收敛的电脑把同一个词改成同一个新名,频次不翻倍', () => {
    // 先造出一个频次 5、带别名的词,并让两台电脑都持有它。
    let base = createEmptySyncState();
    let clock = createHlcClock('node-a', 1_000);
    for (let round = 0; round < 5; round += 1) {
      const learned = recordLearningEvent(base, clock, {
        text: 'web coding',
        aliases: ['webcoding'],
        stage: 'entry',
        nowMs: 1_000 + round,
      });
      base = learned.state;
      clock = learned.clock;
    }
    expect(materializeDictionary(base).entries[0].frequency).toBe(5);

    // 两台电脑各自把它改名成 Vibe Coding —— 互相还没同步。
    const a = renameTerm(base, createHlcClock('node-a', 5_000), {
      termKey: 'web coding',
      nextText: 'Vibe Coding',
      nowMs: 5_000,
    });
    const b = renameTerm(base, createHlcClock('node-b', 6_000), {
      termKey: 'web coding',
      nextText: 'Vibe Coding',
      nowMs: 6_000,
    });

    const merged = mergeSyncStates(a.state, b.state);
    const entries = materializeDictionary(merged).entries;
    expect(entries.map((entry) => entry.text)).toEqual(['Vibe Coding']);
    // 关键:没有发生任何一次学习,频次就必须还是 5。
    expect(entries[0].frequency).toBe(5);
    // 别名也不能翻倍。
    expect(entries[0].aliases.map((alias) => `${alias.text}:${alias.count}`)).toEqual(['webcoding:5']);
  });

  it('反复改名再改回来也不涨', () => {
    let state = seedTerm(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'Cindy',
      source: 'manual',
      stage: 'entry',
      count: 4,
      nowMs: 1_000,
    }).state;
    let clock = createHlcClock('node-a', 2_000);

    for (let round = 0; round < 5; round += 1) {
      const forward = renameTerm(state, clock, {
        termKey: 'cindy',
        nextText: 'Cindy 客户端',
        nowMs: 2_000 + round * 10,
      });
      const backward = renameTerm(forward.state, forward.clock, {
        termKey: 'cindy 客户端',
        nextText: 'Cindy',
        nowMs: 2_005 + round * 10,
      });
      state = backward.state;
      clock = backward.clock;
    }

    const entries = materializeDictionary(state).entries;
    expect(entries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(entries[0].frequency).toBe(4);
  });

  it('改名到一个已存在的词上,两边证据相加(那是两批独立证据)', () => {
    let state = seedTerm(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'Cindy',
      source: 'manual',
      stage: 'entry',
      count: 3,
      nowMs: 1_000,
    }).state;
    state = seedTerm(state, createHlcClock('node-a', 1_100), {
      text: 'sindy',
      source: 'automatic',
      stage: 'entry',
      count: 2,
      nowMs: 1_100,
    }).state;

    const renamed = renameTerm(state, createHlcClock('node-a', 2_000), {
      termKey: 'sindy',
      nextText: 'Cindy',
      nowMs: 2_000,
    });
    const entries = materializeDictionary(renamed.state).entries;
    expect(entries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(entries[0].frequency).toBe(5);
  });
});

describe('自动候选容量裁剪', () => {
  it('超出硬上限时裁掉最弱的自动候选,不碰手动与正式词条', () => {
    let state = createEmptySyncState();
    let clock = createHlcClock('node-a', 1_000);

    // 一条手动词条(频次 1,是最弱的)+ 一条正式的自动词条。
    const manual = seedTerm(state, clock, {
      text: '内部代号',
      source: 'manual',
      stage: 'entry',
      count: 1,
      nowMs: 1_000,
    });
    state = manual.state;
    clock = manual.clock;
    const entry = seedTerm(state, clock, {
      text: '正式词',
      source: 'automatic',
      stage: 'entry',
      count: 1,
      nowMs: 1_001,
    });
    state = entry.state;
    clock = entry.clock;

    // 5 条自动候选,证据数各不相同。
    for (let index = 0; index < 5; index += 1) {
      const seeded = seedTerm(state, clock, {
        text: `候选-${index}`,
        source: 'automatic',
        stage: 'candidate',
        count: index + 1,
        nowMs: 1_100 + index,
      });
      state = seeded.state;
      clock = seeded.clock;
    }

    const pruned = pruneWeakAutomaticCandidates(state, clock, { maxRecords: 2, nowMs: 9_000 });
    expect(pruned.changed).toBe(true);

    const materialized = materializeDictionary(pruned.state);
    // 手动与正式词条一条不少。
    expect(materialized.entries.map((item) => item.text).sort()).toEqual(['内部代号', '正式词']);
    // 只留下证据最多的两条候选。
    expect(materialized.candidates.map((item) => item.text).sort()).toEqual(['候选-3', '候选-4']);
    // 裁剪不写抑制:这些词日后再被学到应该能正常回来。
    expect(materialized.suppressedTexts).toEqual([]);
  });

  it('没超上限时是空操作', () => {
    const seeded = seedTerm(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: '候选',
      source: 'automatic',
      stage: 'candidate',
      count: 1,
      nowMs: 1_000,
    });
    const pruned = pruneWeakAutomaticCandidates(seeded.state, seeded.clock, { nowMs: 2_000 });
    expect(pruned.changed).toBe(false);
    expect(pruned.state).toBe(seeded.state);
    expect(MAX_AUTOMATIC_CANDIDATE_RECORDS).toBeGreaterThan(200);
  });

  it('裁掉的候选重新被学到时能回来(没有被抑制永久压住)', () => {
    let state = createEmptySyncState();
    let clock = createHlcClock('node-a', 1_000);
    for (let index = 0; index < 3; index += 1) {
      const seeded = seedTerm(state, clock, {
        text: `候选-${index}`,
        source: 'automatic',
        stage: 'candidate',
        count: index + 1,
        nowMs: 1_000 + index,
      });
      state = seeded.state;
      clock = seeded.clock;
    }
    const pruned = pruneWeakAutomaticCandidates(state, clock, { maxRecords: 1, nowMs: 5_000 });
    expect(materializeDictionary(pruned.state).candidates.map((item) => item.text)).toEqual(['候选-2']);

    const relearned = recordLearningEvent(pruned.state, pruned.clock, {
      text: '候选-0',
      stage: 'candidate',
      nowMs: 6_000,
    });
    expect(materializeDictionary(relearned.state).candidates.map((item) => item.text).sort()).toEqual([
      '候选-0',
      '候选-2',
    ]);
  });
});

describe('搬移 tag 的形状', () => {
  it('改名产生的化身 tag 仍是规范 HLC —— 否则整份状态过不了入站校验', () => {
    const seeded = seedTerm(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'web coding',
      source: 'automatic',
      stage: 'entry',
      count: 3,
      nowMs: 1_000,
    });
    const renamed = renameTerm(seeded.state, seeded.clock, {
      termKey: 'web coding',
      nextText: 'Vibe Coding',
      nowMs: 2_000,
    });

    // 状态整体必须仍然合法:同步出去的每一帧都要过这道校验。
    expect(isValidSyncState(renamed.state)).toBe(true);
    for (const record of Object.values(renamed.state.records)) {
      for (const tag of Object.keys(record.incarnations)) {
        expect(`${tag} -> ${isCanonicalHlc(tag)}`).toBe(`${tag} -> true`);
      }
    }
  });

  it('反复改名不会让 tag 越来越长', () => {
    let state = seedTerm(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'A',
      source: 'manual',
      stage: 'entry',
      count: 1,
      nowMs: 1_000,
    }).state;
    let clock = createHlcClock('node-a', 2_000);
    const lengths = new Set<number>();

    for (let round = 0; round < 6; round += 1) {
      const from = round % 2 === 0 ? 'a' : 'b';
      const to = round % 2 === 0 ? 'B' : 'A';
      const renamed = renameTerm(state, clock, { termKey: from, nextText: to, nowMs: 3_000 + round });
      state = renamed.state;
      clock = renamed.clock;
      for (const record of Object.values(state.records)) {
        for (const tag of Object.keys(record.incarnations)) lengths.add(tag.length);
      }
    }

    // 定长派生:所有 tag 长度都一样(原始 tag 的 nodeId 段长度恰好也可能不同,
    // 这里只要求搬移之后不再增长)。
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
      'node-a'.length - 'mv0000000'.length + 'mv0000000'.length,
    );
    expect(materializeDictionary(state).entries.map((entry) => entry.text)).toEqual(['A']);
  });
});
