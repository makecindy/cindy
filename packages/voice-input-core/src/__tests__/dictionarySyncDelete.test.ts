/**
 * 删除语义矩阵。
 *
 * 删除是这套同步里最容易做错的一环:做浅了,一台设备删掉的词会被另一台的旧状态
 * 复活;做深了(比如按主键记永久墓碑),用户删掉之后重新添加的同名词又会被自己
 * 的旧墓碑压住。这里把两个方向的失败模式都钉住。
 *
 * 另外 desktop 单机语义在同步之后必须保持不变:
 *  - 删自动词条 → 写抑制集合,后台学习不再把它加回来;
 *  - 删手动词条 → 不写抑制集合,之后自动学习可以合法地重新学出来。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOMBSTONE_TTL_MS,
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  gcTombstones,
  materializeDictionary,
  materializedEntryId,
  mergeSyncStates,
  recordLearningEvent,
  termKeyFromMaterializedId,
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

function learn(
  target: Device,
  text: string,
  nowMs: number,
  stage: 'candidate' | 'entry' = 'entry',
  aliases: string[] = [],
): void {
  const result = recordLearningEvent(target.state, target.clock, { text, aliases, stage, nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function addManual(target: Device, text: string, nowMs: number): void {
  const result = addManualEntry(target.state, target.clock, { text, nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function remove(target: Device, termKey: string, nowMs: number): void {
  const result = deleteTerms(target.state, target.clock, { termKeys: [termKey], nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function entryTexts(state: VoiceDictionarySyncState): string[] {
  return materializeDictionary(state).entries.map((entry) => entry.text);
}

function candidateTexts(state: VoiceDictionarySyncState): string[] {
  return materializeDictionary(state).candidates.map((candidate) => candidate.text);
}

describe('dictionary sync — 删除传播', () => {
  it('一端删除,离线数天的另一端上线后同步消失', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'LiteLLM', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    expect(entryTexts(b.state)).toEqual(['LiteLLM']);

    remove(a, 'litellm', 2_000);
    // B 离线三天后才收到 A 的状态。
    b.state = mergeSyncStates(b.state, a.state);
    expect(entryTexts(b.state)).toEqual([]);
    // 反向合并同样不会把它带回来。
    a.state = mergeSyncStates(a.state, b.state);
    expect(entryTexts(a.state)).toEqual([]);
  });

  it('删除赢过离线期间的后台学习:被删化身上的新增计数一并失效', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'LiteLLM', 1_000);
    b.state = mergeSyncStates(b.state, a.state);

    // A 删除的同时,B 在离线状态下对同一条词继续学习。
    remove(a, 'litellm', 2_000);
    learn(b, 'LiteLLM', 2_100);
    learn(b, 'LiteLLM', 2_200);

    const merged = mergeSyncStates(a.state, b.state);
    expect(entryTexts(merged)).toEqual([]);
    expect(materializeDictionary(mergeSyncStates(b.state, a.state))).toEqual(
      materializeDictionary(merged),
    );
  });

  it('删除手动词条同样跨设备传播 —— 这条路径只有墓碑一道保险', () => {
    // 自动词条的删除有「墓碑 + 抑制」双保险,单看它测不出墓碑传播是否真的生效;
    // 手动词条不写抑制,是墓碑传播的唯一验证路径。
    const a = device('a');
    const b = device('b');
    addManual(a, 'Cindy', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    expect(entryTexts(b.state)).toEqual(['Cindy']);

    remove(a, 'cindy', 2_000);
    expect(materializeDictionary(a.state).suppressedTexts).toEqual([]);

    b.state = mergeSyncStates(b.state, a.state);
    expect(entryTexts(b.state)).toEqual([]);
  });

  it('删除自动词条会把抑制同步到全网,后台学习不再重建', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'Orca', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    remove(a, 'orca', 2_000);
    b.state = mergeSyncStates(b.state, a.state);

    // B 收到抑制之后再学习:不重建。
    learn(b, 'Orca', 3_000);
    expect(entryTexts(b.state)).toEqual([]);
    expect(candidateTexts(b.state)).toEqual([]);
    expect(materializeDictionary(b.state).suppressedTexts).toEqual(['Orca']);
  });

  it('被抑制的词在别处残留自动化身时,学习不再改动状态(不触发无谓的写盘与广播)', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'Orca', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    remove(a, 'orca', 2_000);

    // B 先在本地独立学出一个自己的化身,再收到 A 的删除与抑制。
    learn(b, 'Orca', 2_100);
    b.state = mergeSyncStates(b.state, a.state);
    expect(entryTexts(b.state)).toEqual([]);

    const before = b.state;
    const result = recordLearningEvent(b.state, b.clock, { text: 'Orca', stage: 'entry', nowMs: 3_000 });
    expect(result.changed).toBe(false);
    expect(result.state).toBe(before);
  });

  it('删除手动词条不写抑制,之后自动学习可以重新学出来', () => {
    const a = device('a');
    addManual(a, 'Cindy', 1_000);
    remove(a, 'cindy', 2_000);
    expect(entryTexts(a.state)).toEqual([]);
    expect(materializeDictionary(a.state).suppressedTexts).toEqual([]);

    learn(a, 'Cindy', 3_000);
    expect(entryTexts(a.state)).toEqual(['Cindy']);
    // 重新学出来的是全新化身,计数从零起。
    expect(materializeDictionary(a.state).entries[0].frequency).toBe(1);
  });

  it('删除后重新手动添加同名词不会被旧墓碑压住', () => {
    const a = device('a');
    learn(a, 'Orca', 1_000);
    learn(a, 'Orca', 1_100);
    remove(a, 'orca', 2_000);
    expect(entryTexts(a.state)).toEqual([]);

    // 手动添加不受抑制集合限制 —— 用户显式要它回来。
    addManual(a, 'Orca', 3_000);
    const materialized = materializeDictionary(a.state);
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['Orca']);
    expect(materialized.entries[0].source).toBe('manual');
    // 旧化身的计数没有被带回来。
    expect(materialized.entries[0].frequency).toBe(1);
  });

  it('删除与并发重新添加:add-wins,用户新表达的意图胜出', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'Orca', 1_000);
    b.state = mergeSyncStates(b.state, a.state);

    remove(a, 'orca', 2_000);
    addManual(b, 'Orca', 2_000); // B 并不知道 A 删了

    const forward = mergeSyncStates(a.state, b.state);
    const backward = mergeSyncStates(b.state, a.state);
    expect(entryTexts(forward)).toEqual(['Orca']);
    expect(materializeDictionary(forward)).toEqual(materializeDictionary(backward));
  });

  it('删除词条会一并带走同名候选词', () => {
    const a = device('a');
    learn(a, 'device-link', 1_000, 'candidate');
    expect(candidateTexts(a.state)).toEqual(['device-link']);
    remove(a, 'device-link', 2_000);
    expect(candidateTexts(a.state)).toEqual([]);
    expect(entryTexts(a.state)).toEqual([]);
  });

  it('删除操作的合并结果与合并顺序无关', () => {
    const a = device('a');
    const b = device('b');
    const c = device('c');
    learn(a, 'LiteLLM', 1_000);
    learn(a, 'Orca', 1_010);
    b.state = mergeSyncStates(b.state, a.state);
    c.state = mergeSyncStates(c.state, a.state);

    remove(b, 'litellm', 2_000);
    learn(c, 'LiteLLM', 2_050);
    addManual(c, 'Orca', 2_060);

    const order1 = mergeSyncStates(mergeSyncStates(a.state, b.state), c.state);
    const order2 = mergeSyncStates(mergeSyncStates(c.state, b.state), a.state);
    const order3 = mergeSyncStates(a.state, mergeSyncStates(b.state, c.state));
    expect(materializeDictionary(order1)).toEqual(materializeDictionary(order2));
    expect(materializeDictionary(order1)).toEqual(materializeDictionary(order3));
  });

  it('重复投递删除状态不会把词条复活,也不会改变结果', () => {
    const a = device('a');
    const b = device('b');
    learn(a, 'LiteLLM', 1_000);
    b.state = mergeSyncStates(b.state, a.state);
    const staleSnapshot = b.state; // 删除之前的旧快照,稍后反复送达
    remove(a, 'litellm', 2_000);
    b.state = mergeSyncStates(b.state, a.state);

    for (let round = 0; round < 20; round += 1) {
      b.state = mergeSyncStates(b.state, staleSnapshot);
    }
    expect(entryTexts(b.state)).toEqual([]);
  });
});

describe('dictionary sync — 词条 id 与删除入口', () => {
  it('物化 id 稳定且可翻译回合并主键', () => {
    const a = device('a');
    learn(a, 'Vibe Coding', 1_000);
    const entry = materializeDictionary(a.state).entries[0];
    expect(entry.id).toBe(materializedEntryId('vibe coding'));

    const key = termKeyFromMaterializedId(a.state, entry.id);
    expect(key).toBe('vibe coding');
    remove(a, key!, 2_000);
    expect(entryTexts(a.state)).toEqual([]);
  });

  it('未知 id 翻译为 null,不会误伤别的词条', () => {
    const a = device('a');
    learn(a, 'Vibe Coding', 1_000);
    expect(termKeyFromMaterializedId(a.state, materializedEntryId('nonexistent'))).toBeNull();
    expect(termKeyFromMaterializedId(a.state, 'dict-1700000000-legacy')).toBeNull();
    expect(termKeyFromMaterializedId(a.state, '   ')).toBeNull();
  });

  it('同一个词在不同设备上物化出相同 id', () => {
    const a = device('a');
    const b = device('b', 9_999);
    learn(a, 'Vibe Coding', 1_000);
    learn(b, 'vibe coding', 5_000);
    const idA = materializeDictionary(a.state).entries[0].id;
    const idB = materializeDictionary(b.state).entries[0].id;
    expect(idA).toBe(idB);
  });
});

describe('dictionary sync — 墓碑回收', () => {
  it('回收过期墓碑时连同被覆盖的化身一起删除,不会复活词条', () => {
    const a = device('a');
    learn(a, 'LiteLLM', 1_000);
    remove(a, 'litellm', 2_000);

    const collected = gcTombstones(a.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    expect(entryTexts(collected)).toEqual([]);
    // 化身必须随墓碑一起消失 —— 只删墓碑会让词条立刻复活。
    expect(Object.keys(collected.records['litellm']?.incarnations ?? {})).toEqual([]);
    // 抑制不参与回收,自动词条仍然不会被后台学习重建。
    expect(materializeDictionary(collected).suppressedTexts).toEqual(['LiteLLM']);
  });

  it('未到期的墓碑不被回收', () => {
    const a = device('a');
    learn(a, 'LiteLLM', 1_000);
    remove(a, 'litellm', 2_000);
    const collected = gcTombstones(a.state, { nowMs: 3_000, ttlMs: DEFAULT_TOMBSTONE_TTL_MS });
    expect(collected).toEqual(a.state);
  });
});
