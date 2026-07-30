/**
 * 两条容易互相打架的恢复路径。
 *
 * - **降级回收**:老客户端直接改了词典文件。投影是刚写下的新证据,即使某个键上只剩
 *   墓碑也要重建 —— 否则用户在老客户端加的词升级后凭空消失。
 * - **sidecar 恢复**:本机丢了同步状态、投影还在。此时本机没有任何身份历史,重建
 *   出来的化身自带新 tag,别的设备上「删掉这个词」的墓碑盖不住它 —— 越过墓碑重建
 *   就是让删掉的词复活。
 *
 * 同一个 `seedTerm` 要同时满足这两条,靠的就是 `allowTombstonedRevival`。
 */

import { describe, expect, it } from 'vitest';

import {
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  materializeDictionary,
  mergeSyncStates,
  reconcileFromLocalSnapshot,
} from '../dictionary-sync';

describe('墓碑与重建', () => {
  it('降级回收允许越过墓碑重建(老客户端刚加回来的词)', () => {
    const added = addManualEntry(createEmptySyncState(), createHlcClock('a', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    });
    const removed = deleteTerms(added.state, added.clock, { termKeys: ['cindy'], nowMs: 2_000 });

    const result = reconcileFromLocalSnapshot(removed.state, removed.clock, {
      snapshot: { entries: [{ text: 'Cindy', source: 'manual', frequency: 3 }], suppressedTexts: [] },
      lastMaterializedKeys: [],
      nowMs: 3_000,
    });

    expect(materializeDictionary(result.state).entries.map((entry) => entry.text)).toEqual(['Cindy']);
  });

  it('sidecar 恢复不越过墓碑 —— 别的设备删掉的词不会复活', () => {
    // 设备 B 删掉了这个词。
    const added = addManualEntry(createEmptySyncState(), createHlcClock('b', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    });
    const peerAfterDelete = deleteTerms(added.state, added.clock, {
      termKeys: ['cindy'],
      nowMs: 2_000,
    });

    // 设备 A 丢了 sidecar,只剩一份还写着这个词的投影文件。先合并对端(墓碑到齐),
    // 再按恢复语义认领 —— 这正是延迟恢复要保证的顺序。
    const merged = mergeSyncStates(createEmptySyncState(), peerAfterDelete.state);
    const recovered = reconcileFromLocalSnapshot(merged, createHlcClock('a', 5_000), {
      snapshot: { entries: [{ text: 'Cindy', source: 'manual', frequency: 9 }], suppressedTexts: [] },
      lastMaterializedKeys: [],
      nowMs: 5_000,
      allowTombstonedRevival: false,
    });

    expect(materializeDictionary(recovered.state).entries).toEqual([]);
    // 再与对端合并一次也不会复活(幂等,且没造出新化身)。
    expect(materializeDictionary(mergeSyncStates(recovered.state, peerAfterDelete.state)).entries)
      .toEqual([]);
  });

  it('恢复模式仍然认领对端没删过的词', () => {
    const peer = addManualEntry(createEmptySyncState(), createHlcClock('b', 1_000), {
      text: 'Orca',
      nowMs: 1_000,
    });
    const recovered = reconcileFromLocalSnapshot(peer.state, createHlcClock('a', 5_000), {
      snapshot: {
        entries: [
          { text: 'Orca', source: 'manual', frequency: 4 },
          { text: 'Vibe Coding', source: 'manual', frequency: 2 },
        ],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 5_000,
      allowTombstonedRevival: false,
    });

    expect(materializeDictionary(recovered.state).entries.map((entry) => entry.text).sort()).toEqual([
      'Orca',
      'Vibe Coding',
    ]);
  });

  it('降级期间老客户端把候选词转正,回收要认下这次转正', () => {
    // 状态里是候选。
    const seeded = reconcileFromLocalSnapshot(createEmptySyncState(), createHlcClock('a', 1_000), {
      snapshot: {
        entries: [],
        suppressedTexts: [],
        candidates: [{ text: 'Cindy', evidenceCount: 2 }],
      },
      lastMaterializedKeys: [],
      nowMs: 1_000,
    });
    expect(materializeDictionary(seeded.state).candidates.map((item) => item.text)).toEqual(['Cindy']);

    // 老客户端把它转正:文件里现在是正式词条,而这个键从没进过 lastMaterializedKeys。
    const promoted = reconcileFromLocalSnapshot(seeded.state, seeded.clock, {
      snapshot: {
        entries: [{ text: 'Cindy', source: 'automatic', frequency: 2 }],
        suppressedTexts: [],
      },
      lastMaterializedKeys: [],
      nowMs: 2_000,
    });

    const materialized = materializeDictionary(promoted.state);
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(materialized.candidates).toEqual([]);
    // 只提升阶段,不补记证据。
    expect(materialized.entries[0].frequency).toBe(2);
  });
});

describe('上限裁决', () => {
  it('手动词条不会被高频自动词条挤出上限,展示顺序仍按频次', () => {
    let state = createEmptySyncState();
    let clock = createHlcClock('a', 1_000);
    // 先塞满 automatic 高频词。
    for (let index = 0; index < 5; index += 1) {
      const result = reconcileFromLocalSnapshot(state, clock, {
        snapshot: {
          entries: [{ text: `auto-${index}`, source: 'automatic', frequency: 50 + index }],
          suppressedTexts: [],
        },
        lastMaterializedKeys: [],
        nowMs: 1_000 + index,
      });
      state = result.state;
      clock = result.clock;
    }
    // 一条低频手动词。
    const manual = addManualEntry(state, clock, { text: '内部代号', nowMs: 2_000 });
    state = manual.state;

    const materialized = materializeDictionary(state, { maxEntries: 3 });
    const texts = materialized.entries.map((entry) => entry.text);
    expect(texts).toContain('内部代号');
    expect(texts).toHaveLength(3);
    // 展示顺序仍是频次降序:手动优先只决定谁被裁掉。
    const frequencies = materialized.entries.map((entry) => entry.frequency);
    expect([...frequencies].sort((a, b) => b - a)).toEqual(frequencies);
  });
});
