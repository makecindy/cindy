import { describe, expect, it } from 'vitest';

import {
  buildStateVersionVector,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  isTermSuppressed,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  promoteTermToEntry,
  reconcileFromLocalSnapshot,
  recordLearningEvent,
  unsuppressTerm,
  versionVectorDominates,
} from '../dictionary-sync';

describe('dictionary sync — 抑制恢复与候选手动晋升', () => {
  it('解除抑制后允许自动学习重新收录，且跨设备合并满足幂等/交换/结合', () => {
    let clockA = createHlcClock('node-a', 1_000);
    let clockB = createHlcClock('node-b', 1_000);
    let stateA = createEmptySyncState();

    // A 自动学出词条后删除 -> 进入抑制集合
    const learned = recordLearningEvent(stateA, clockA, {
      text: 'Vibe Coding',
      aliases: ['web coding'],
      stage: 'entry',
      nowMs: 1_000,
    });
    stateA = learned.state;
    clockA = learned.clock;

    const deleted = deleteTerms(stateA, clockA, {
      termKeys: ['vibe coding'],
      nowMs: 1_100,
    });
    stateA = deleted.state;
    clockA = deleted.clock;
    expect(isTermSuppressed(stateA, 'vibe coding')).toBe(true);
    expect(materializeDictionary(stateA).suppressedTexts).toEqual(['Vibe Coding']);

    // B 收到旧状态（只含 suppressed），A 随后解除抑制
    const stateB = mergeSyncStates(createEmptySyncState(), stateA);
    const restored = unsuppressTerm(stateA, clockA, {
      termKey: 'Vibe Coding',
      nowMs: 1_200,
    });
    expect(restored.changed).toBe(true);
    stateA = restored.state;
    clockA = restored.clock;
    expect(isTermSuppressed(stateA, 'vibe coding')).toBe(false);
    expect(materializeDictionary(stateA).suppressedTexts).toEqual([]);
    expect(isValidSyncState(stateA)).toBe(true);
    expect(versionVectorDominates(buildStateVersionVector(stateA), buildStateVersionVector(stateB))).toBe(true);

    // 合并旧状态 B 回来时不会让抑制复活；同时满足幂等/交换/结合
    const stateC = mergeSyncStates(stateB, stateA);
    expect(stateC).toEqual(mergeSyncStates(stateA, stateB));
    expect(mergeSyncStates(stateC, stateC)).toEqual(stateC);
    expect(mergeSyncStates(mergeSyncStates(stateA, stateB), stateC)).toEqual(
      mergeSyncStates(stateA, mergeSyncStates(stateB, stateC)),
    );
    expect(isTermSuppressed(stateC, 'vibe coding')).toBe(false);

    // 解除抑制后可以再次自动学习，并支持再次删除重回抑制态
    const relearned = recordLearningEvent(stateC, clockB, {
      text: 'Vibe Coding',
      stage: 'entry',
      nowMs: 1_300,
    });
    expect(relearned.changed).toBe(true);
    expect(materializeDictionary(relearned.state).entries.map((entry) => entry.text)).toEqual(['Vibe Coding']);

    const redeleted = deleteTerms(relearned.state, relearned.clock, {
      termKeys: ['vibe coding'],
      nowMs: 1_400,
    });
    expect(isTermSuppressed(redeleted.state, 'vibe coding')).toBe(true);
    expect(materializeDictionary(redeleted.state).suppressedTexts).toEqual(['Vibe Coding']);
    // 再次合入较早的“已恢复”状态不会推翻更晚的再次抑制
    const mergedAfterResuppress = mergeSyncStates(redeleted.state, stateA);
    expect(isTermSuppressed(mergedAfterResuppress, 'vibe coding')).toBe(true);
  });

  it('手动晋升候选词保留证据计数和别名，并标记为 manual 正式词条', () => {
    const clock = createHlcClock('node-a', 2_000);
    const learned = recordLearningEvent(createEmptySyncState(), clock, {
      text: 'SherpaONNX',
      aliases: ['舌帕 onnx'],
      stage: 'candidate',
      nowMs: 2_000,
    });
    const promoted = promoteTermToEntry(learned.state, learned.clock, {
      termKey: 'SherpaONNX',
      nowMs: 2_100,
      markManual: true,
    });
    expect(promoted.changed).toBe(true);
    const materialized = materializeDictionary(promoted.state);
    expect(materialized.candidates).toEqual([]);
    expect(materialized.entries).toHaveLength(1);
    expect(materialized.entries[0]).toMatchObject({
      text: 'SherpaONNX',
      source: 'manual',
      frequency: 1,
    });
    expect(materialized.entries[0].aliases.map((alias) => alias.text)).toEqual(['舌帕 onnx']);
  });

  it('降级到旧版客户端再次抑制已恢复词条时，reconcile 能正确认领', () => {
    const clock = createHlcClock('node-a', 3_000);
    const learned = recordLearningEvent(createEmptySyncState(), clock, {
      text: 'Orca',
      stage: 'entry',
      nowMs: 3_000,
    });
    const deleted = deleteTerms(learned.state, learned.clock, {
      termKeys: ['orca'],
      nowMs: 3_100,
    });
    const restored = unsuppressTerm(deleted.state, deleted.clock, {
      termKey: 'orca',
      nowMs: 3_200,
    });
    expect(isTermSuppressed(restored.state, 'orca')).toBe(false);

    const reclaimed = reconcileFromLocalSnapshot(restored.state, restored.clock, {
      snapshot: { entries: [], suppressedTexts: ['Orca'] },
      lastMaterializedKeys: [],
      nowMs: 3_300,
    });
    expect(reclaimed.changed).toBe(true);
    expect(isTermSuppressed(reclaimed.state, 'orca')).toBe(true);
  });

  it('校验拒绝畸形的 suppressionEvents', () => {
    const base = createEmptySyncState();
    expect(isValidSyncState({ ...base, suppressionEvents: { k: {} } })).toBe(false);
    expect(isValidSyncState({ ...base, suppressionEvents: { k: { unsuppressedAt: 'bad' } } })).toBe(false);
    expect(isValidSyncState({ ...base, suppressionEvents: [] })).toBe(false);
  });
});
