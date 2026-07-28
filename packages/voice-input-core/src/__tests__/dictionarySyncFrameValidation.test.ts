/**
 * 入站帧的时间戳必须是规范 HLC。
 *
 * 定序靠字符串字典序,前提是所有时间戳都符合定长格式。`~`(码位高于所有 base36
 * 字符)构成的假时间戳会在每一次 LWW 比较里胜出,而且它会被持久化并继续同步出去 ——
 * 那个字段此后在所有设备上都改不动了。这类帧必须在进合并之前就被挡住。
 */

import { describe, expect, it } from 'vitest';

import {
  addManualEntry,
  buildStateVersionVector,
  createEmptySyncState,
  createHlcClock,
  isCanonicalHlc,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  renameTerm,
  versionVectorDominates,
} from '../dictionary-sync';

function validState() {
  const added = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
    text: 'Cindy',
    nowMs: 1_000,
  });
  return JSON.parse(JSON.stringify(added.state)) as ReturnType<typeof createEmptySyncState>;
}

describe('规范 HLC', () => {
  it('认得出合法与非法形状', () => {
    expect(isCanonicalHlc('0000000rs4.0000.node-a')).toBe(true);
    expect(isCanonicalHlc('~~~~')).toBe(false);
    expect(isCanonicalHlc('0000000rs4.0000.')).toBe(false); // nodeId 为空
    expect(isCanonicalHlc('0000000rs4.0000.a.b')).toBe(false); // nodeId 含 '.'
    expect(isCanonicalHlc('0000000rs4.000.node-a')).toBe(false); // counter 段长度不对
    expect(isCanonicalHlc('ZZZZZZZZZZ.0000.node-a')).toBe(false); // 大写不是 base36 输出
    expect(isCanonicalHlc(42)).toBe(false);
  });

  it('假时间戳的帧整帧被拒,不会污染本机词典', () => {
    const state = validState();
    const key = Object.keys(state.records)[0];
    const tag = Object.keys(state.records[key].incarnations)[0];
    state.records[key].incarnations[tag].textStamp = '~~~~';

    expect(isValidSyncState(state)).toBe(false);
  });

  it('化身键与自称 tag 不一致的帧被拒', () => {
    const state = validState();
    const key = Object.keys(state.records)[0];
    const tag = Object.keys(state.records[key].incarnations)[0];
    const incarnation = state.records[key].incarnations[tag];
    delete state.records[key].incarnations[tag];
    state.records[key].incarnations['0000000rs4.0001.node-b'] = incarnation;

    expect(isValidSyncState(state)).toBe(false);
  });

  it('拒帧之后本机仍能正常改这个词 —— 假戳没有留下来', () => {
    const added = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'Cindy',
      nowMs: 1_000,
    });
    const renamed = renameTerm(added.state, added.clock, {
      termKey: 'cindy',
      nextText: 'Cindy 客户端',
      nowMs: 2_000,
    });
    expect(materializeDictionary(renamed.state).entries[0].text).toBe('Cindy 客户端');
  });
});

describe('版本向量', () => {
  it('合并后的状态包含两边 —— 逐节点 ≥ 双方', () => {
    const a = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'foo',
      nowMs: 1_000,
    });
    const b = addManualEntry(createEmptySyncState(), createHlcClock('node-b', 2_000), {
      text: 'bar',
      nowMs: 2_000,
    });
    const merged = mergeSyncStates(a.state, b.state);

    const vectorA = buildStateVersionVector(a.state);
    const vectorB = buildStateVersionVector(b.state);
    const vectorMerged = buildStateVersionVector(merged);

    expect(versionVectorDominates(vectorMerged, vectorA)).toBe(true);
    expect(versionVectorDominates(vectorMerged, vectorB)).toBe(true);
    // 并发的两份互不包含 —— 这正是「只比最大 HLC」判不出来的情况。
    expect(versionVectorDominates(vectorA, vectorB)).toBe(false);
    expect(versionVectorDominates(vectorB, vectorA)).toBe(false);
  });

  it('向量对合并单调:再合并一次不会让它变小', () => {
    const a = addManualEntry(createEmptySyncState(), createHlcClock('node-a', 1_000), {
      text: 'foo',
      nowMs: 1_000,
    });
    const once = buildStateVersionVector(a.state);
    const twice = buildStateVersionVector(mergeSyncStates(a.state, a.state));
    expect(versionVectorDominates(twice, once)).toBe(true);
    expect(versionVectorDominates(once, twice)).toBe(true);
  });
});

describe('数值字段的校验', () => {
  function poison(mutate: (incarnation: Record<string, unknown>) => void) {
    const state = validState();
    const key = Object.keys(state.records)[0];
    const tag = Object.keys(state.records[key].incarnations)[0];
    mutate(state.records[key].incarnations[tag] as unknown as Record<string, unknown>);
    return state;
  }

  it('时间戳必须有限 —— NaN / Infinity 会顺着 Math.min/max 污染整条词条', () => {
    expect(isValidSyncState(poison((item) => { item.createdAt = Number.NaN; }))).toBe(false);
    expect(isValidSyncState(poison((item) => { item.updatedAt = Number.POSITIVE_INFINITY; }))).toBe(false);
    expect(isValidSyncState(poison((item) => { item.createdAt = -1; }))).toBe(false);
  });

  it('别名的 lastSeenAt 同样要求有限', () => {
    const state = validState();
    const key = Object.keys(state.records)[0];
    const tag = Object.keys(state.records[key].incarnations)[0];
    const incarnation = state.records[key].incarnations[tag];
    incarnation.aliases = {
      'web coding': {
        text: 'web coding',
        textStamp: incarnation.textStamp,
        counters: { 'node-a': 1 },
        lastSeenAt: Number.NaN,
      },
    };
    expect(isValidSyncState(state)).toBe(false);
  });

  it('计数必须是非负安全整数', () => {
    expect(isValidSyncState(poison((item) => { item.counters = { 'node-a': -3 }; }))).toBe(false);
    expect(isValidSyncState(poison((item) => { item.counters = { 'node-a': 1.5 }; }))).toBe(false);
    expect(isValidSyncState(poison((item) => { item.counters = { 'node-a': Number.MAX_SAFE_INTEGER + 2 }; })))
      .toBe(false);
    // 0 是合法的:别名可能被减到 0 之后仍留在结构里。
    expect(isValidSyncState(poison((item) => { item.counters = { 'node-a': 0 }; }))).toBe(true);
  });
});
