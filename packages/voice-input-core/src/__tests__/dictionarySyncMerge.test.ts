/**
 * 合并核心的性质测试。
 *
 * 这里刻意不是场景枚举,而是用固定种子的伪随机器把「多设备 × 随机事件 × 随机
 * 同步拓扑 × 丢帧重帧乱序」跑成千上万种组合,断言两类性质:
 *
 *  1. 代数性质:幂等 / 可交换 / 可结合 —— 保证同步链路不需要可靠投递。
 *  2. 守恒性质:任意同步历史之后,词条显示频次**恰好等于**全局真实事件数 ——
 *     直接盯防「词典随同步次数重复增长」这一类 bug。
 *
 * 种子固定,失败可复现;不引入 fast-check 之类新依赖。
 */

import { describe, expect, it } from 'vitest';

import {
  addManualEntry,
  createEmptySyncState,
  createHlcClock,
  findMaxHlc,
  materializeDictionary,
  mergeSyncStates,
  observeHlc,
  recordLearningEvent,
  type HlcClock,
  type VoiceDictionarySyncState,
} from '../dictionary-sync';

/** mulberry32:小、快、确定性好的种子伪随机器。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TERMS = ['Vibe Coding', 'LiteLLM', 'Cindy', 'Orca', '语音输入', 'device-link'];
const ALIASES: Record<string, string[]> = {
  'Vibe Coding': ['web coding', '外部 coding'],
  LiteLLM: ['light LLM'],
  Cindy: ['sindy', '辛迪'],
  Orca: ['okra'],
  语音输入: ['语音数入'],
  'device-link': ['device link'],
};

interface Device {
  id: string;
  state: VoiceDictionarySyncState;
  clock: HlcClock;
}

function createDevice(index: number): Device {
  return {
    id: `node-${index}`,
    state: createEmptySyncState(),
    clock: createHlcClock(`node-${index}`, 1_700_000_000_000),
  };
}

/** 单向投递:把 from 的当前状态合进 to(模拟一帧 push 送达)。 */
function deliver(to: Device, from: Device, nowMs: number): void {
  const snapshot = from.state;
  to.state = mergeSyncStates(to.state, snapshot);
  const max = findMaxHlc(snapshot);
  if (max) to.clock = observeHlc(to.clock, max, nowMs);
}

interface SimulationResult {
  devices: Device[];
  /** termKey → 全局真实学习事件数。 */
  truth: Map<string, number>;
}

function simulate(seed: number, deviceCount: number, steps: number): SimulationResult {
  const random = createRandom(seed);
  const devices = Array.from({ length: deviceCount }, (_, index) => createDevice(index));
  const truth = new Map<string, number>();
  // 送达队列里保留旧快照,用来制造「乱序 + 迟到 + 重复投递」。
  const inFlight: Array<{ to: number; state: VoiceDictionarySyncState }> = [];
  let nowMs = 1_700_000_000_000;

  for (let step = 0; step < steps; step += 1) {
    nowMs += Math.floor(random() * 5);
    const roll = random();
    const deviceIndex = Math.floor(random() * deviceCount);
    const device = devices[deviceIndex];

    if (roll < 0.5) {
      const term = TERMS[Math.floor(random() * TERMS.length)];
      const stage = random() < 0.4 ? 'entry' : 'candidate';
      const result = recordLearningEvent(device.state, device.clock, {
        text: term,
        aliases: ALIASES[term],
        stage,
        nowMs,
      });
      device.state = result.state;
      device.clock = result.clock;
      if (result.changed) {
        const key = term.toLowerCase();
        truth.set(key, (truth.get(key) ?? 0) + 1);
      }
      continue;
    }

    if (roll < 0.75) {
      // 立即投递:模拟设备在线时的即时同步。
      const targetIndex = Math.floor(random() * deviceCount);
      if (targetIndex !== deviceIndex) deliver(devices[targetIndex], device, nowMs);
      continue;
    }

    if (roll < 0.9) {
      // 把当前快照丢进队列,稍后(可能很久之后)再送达,并且可能送多次。
      const targetIndex = Math.floor(random() * deviceCount);
      if (targetIndex !== deviceIndex) inFlight.push({ to: targetIndex, state: device.state });
      continue;
    }

    if (inFlight.length > 0) {
      const pick = Math.floor(random() * inFlight.length);
      const frame = inFlight[pick];
      devices[frame.to].state = mergeSyncStates(devices[frame.to].state, frame.state);
      // 一半概率留在队列里,制造重复投递;另一半才真正出队(模拟丢帧则是永不出队)。
      if (random() < 0.5) inFlight.splice(pick, 1);
    }
  }

  // 收敛:全部两两同步若干轮,直到任意设备都见过所有状态。
  for (let round = 0; round < deviceCount + 1; round += 1) {
    for (const to of devices) {
      for (const from of devices) {
        if (to !== from) deliver(to, from, (nowMs += 1));
      }
    }
  }

  return { devices, truth };
}

function readTotals(state: VoiceDictionarySyncState): Map<string, number> {
  const materialized = materializeDictionary(state);
  const totals = new Map<string, number>();
  for (const entry of materialized.entries) totals.set(entry.text.toLowerCase(), entry.frequency);
  for (const candidate of materialized.candidates) {
    totals.set(candidate.text.toLowerCase(), candidate.evidenceCount);
  }
  return totals;
}

describe('dictionary sync — 代数性质', () => {
  const seeds = [1, 7, 42, 1337, 90210];

  it('幂等:merge(a, a) === a', () => {
    for (const seed of seeds) {
      const { devices } = simulate(seed, 3, 120);
      for (const device of devices) {
        expect(mergeSyncStates(device.state, device.state)).toEqual(device.state);
      }
    }
  });

  it('可交换:merge(a, b) === merge(b, a)', () => {
    for (const seed of seeds) {
      const { devices } = simulate(seed, 3, 120);
      const [a, b] = devices;
      expect(mergeSyncStates(a.state, b.state)).toEqual(mergeSyncStates(b.state, a.state));
    }
  });

  it('可结合:merge(merge(a, b), c) === merge(a, merge(b, c))', () => {
    for (const seed of seeds) {
      const { devices } = simulate(seed, 3, 120);
      const [a, b, c] = devices;
      expect(mergeSyncStates(mergeSyncStates(a.state, b.state), c.state)).toEqual(
        mergeSyncStates(a.state, mergeSyncStates(b.state, c.state)),
      );
    }
  });

  it('收敛:任意同步历史之后所有设备物化结果一致', () => {
    for (const seed of seeds) {
      const { devices } = simulate(seed, 4, 400);
      const reference = materializeDictionary(devices[0].state);
      for (const device of devices.slice(1)) {
        expect(materializeDictionary(device.state)).toEqual(reference);
      }
    }
  });
});

describe('dictionary sync — 频次守恒(防重复增长)', () => {
  it('显示频次恰好等于全局真实事件数,与同步次数、拓扑、重复投递无关', () => {
    for (const seed of [3, 11, 29, 101, 555, 8_192]) {
      const { devices, truth } = simulate(seed, 4, 600);
      for (const device of devices) {
        const totals = readTotals(device.state);
        expect(totals.size).toBe(truth.size);
        for (const [key, expected] of truth) {
          expect(`${key}=${totals.get(key)}`).toBe(`${key}=${expected}`);
        }
      }
    }
  });

  it('反复同步同一份状态不会让频次增长', () => {
    const { devices, truth } = simulate(17, 3, 200);
    const before = readTotals(devices[0].state);
    for (let round = 0; round < 50; round += 1) {
      devices[0].state = mergeSyncStates(devices[0].state, devices[1].state);
      devices[1].state = mergeSyncStates(devices[1].state, devices[0].state);
    }
    const after = readTotals(devices[0].state);
    expect(after).toEqual(before);
    for (const [key, expected] of truth) expect(after.get(key)).toBe(expected);
  });

  it('两台设备各学同一个词 3 次,合并后是 6 次而不是 3 次或 12 次', () => {
    let a = { state: createEmptySyncState(), clock: createHlcClock('a', 1_000) };
    let b = { state: createEmptySyncState(), clock: createHlcClock('b', 1_000) };
    for (let index = 0; index < 3; index += 1) {
      const resultA = recordLearningEvent(a.state, a.clock, {
        text: 'Vibe Coding',
        aliases: ['web coding'],
        stage: 'entry',
        nowMs: 1_000 + index,
      });
      a = { state: resultA.state, clock: resultA.clock };
      const resultB = recordLearningEvent(b.state, b.clock, {
        text: 'Vibe Coding',
        aliases: ['web coding'],
        stage: 'entry',
        nowMs: 1_000 + index,
      });
      b = { state: resultB.state, clock: resultB.clock };
    }

    const merged = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(merged).entries[0].frequency).toBe(6);
    // 再合并任意多轮仍是 6 —— 幂等,不随同步次数膨胀。
    let repeated = merged;
    for (let round = 0; round < 10; round += 1) {
      repeated = mergeSyncStates(repeated, mergeSyncStates(a.state, b.state));
    }
    expect(materializeDictionary(repeated).entries[0].frequency).toBe(6);
  });

  it('候选晋升为正式词条不重复计数', () => {
    // A 攒两次证据 → 同步给 B → 两端各自晋升一次。真实事件共 4 次。
    let a = { state: createEmptySyncState(), clock: createHlcClock('a', 2_000) };
    for (let index = 0; index < 2; index += 1) {
      const result = recordLearningEvent(a.state, a.clock, {
        text: 'Orca',
        aliases: ['okra'],
        stage: 'candidate',
        nowMs: 2_000 + index,
      });
      a = { state: result.state, clock: result.clock };
    }
    let b = { state: mergeSyncStates(createEmptySyncState(), a.state), clock: createHlcClock('b', 2_010) };

    const promotedA = recordLearningEvent(a.state, a.clock, { text: 'Orca', stage: 'entry', nowMs: 2_020 });
    a = { state: promotedA.state, clock: promotedA.clock };
    const promotedB = recordLearningEvent(b.state, b.clock, { text: 'Orca', stage: 'entry', nowMs: 2_021 });
    b = { state: promotedB.state, clock: promotedB.clock };

    const merged = mergeSyncStates(a.state, b.state);
    const materialized = materializeDictionary(merged);
    expect(materialized.candidates).toHaveLength(0);
    expect(materialized.entries).toHaveLength(1);
    expect(materialized.entries[0].frequency).toBe(4);
  });

  it('手动添加的词条频次为 1,重复添加不再增长', () => {
    const clock = createHlcClock('a', 3_000);
    const added = addManualEntry(createEmptySyncState(), clock, { text: 'Cindy', nowMs: 3_000 });
    const materialized = materializeDictionary(added.state);
    expect(materialized.entries).toHaveLength(1);
    expect(materialized.entries[0].frequency).toBe(1);
    expect(materialized.entries[0].source).toBe('manual');

    // 手动添加已存在的词条不再 +1。
    const again = addManualEntry(added.state, added.clock, { text: 'cindy', nowMs: 3_010 });
    expect(materializeDictionary(again.state).entries[0].frequency).toBe(1);
  });
});

describe('dictionary sync — 别名合并', () => {
  it('别名计数同样守恒,且跨设备排序确定', () => {
    let a = { state: createEmptySyncState(), clock: createHlcClock('a', 4_000) };
    let b = { state: createEmptySyncState(), clock: createHlcClock('b', 4_000) };
    for (let index = 0; index < 2; index += 1) {
      const resultA = recordLearningEvent(a.state, a.clock, {
        text: 'Vibe Coding',
        aliases: ['web coding'],
        stage: 'entry',
        nowMs: 4_000 + index,
      });
      a = { state: resultA.state, clock: resultA.clock };
    }
    const resultB = recordLearningEvent(b.state, b.clock, {
      text: 'Vibe Coding',
      aliases: ['web coding', '外部 coding'],
      stage: 'entry',
      nowMs: 4_100,
    });
    b = { state: resultB.state, clock: resultB.clock };

    const left = materializeDictionary(mergeSyncStates(a.state, b.state));
    const right = materializeDictionary(mergeSyncStates(b.state, a.state));
    expect(left).toEqual(right);
    const aliases = left.entries[0].aliases;
    expect(aliases.find((alias) => alias.text === 'web coding')?.count).toBe(3);
    expect(aliases.find((alias) => alias.text === '外部 coding')?.count).toBe(1);
  });

  it('别名等于词条本身时被丢弃', () => {
    const clock = createHlcClock('a', 5_000);
    const result = recordLearningEvent(createEmptySyncState(), clock, {
      text: 'Cindy',
      aliases: ['cindy', 'sindy'],
      stage: 'entry',
      nowMs: 5_000,
    });
    const aliases = materializeDictionary(result.state).entries[0].aliases;
    expect(aliases.map((alias) => alias.text)).toEqual(['sindy']);
  });
});

describe('dictionary sync — 远端帧深度校验', () => {
  it('接受结构完整的状态', async () => {
    const { isValidSyncState } = await import('../dictionary-sync');
    const { devices } = simulate(5, 2, 60);
    expect(isValidSyncState(devices[0].state)).toBe(true);
    expect(isValidSyncState(createEmptySyncState())).toBe(true);
  });

  it('拒绝畸形的嵌套结构 —— 只校验顶层会让坏帧一路持久化,重启后依旧中毒', async () => {
    const { isValidSyncState } = await import('../dictionary-sync');
    const base = { version: 1, records: {}, suppressed: {} };
    const incarnation = {
      tag: 'a', text: 'x', textStamp: 'a', source: 'manual', stage: 'entry',
      counters: { n: 1 }, aliases: {}, createdAt: 1, updatedAt: 1,
    };

    // 顶层就不合法
    expect(isValidSyncState(null)).toBe(false);
    expect(isValidSyncState([])).toBe(false);
    expect(isValidSyncState({ ...base, version: 2 })).toBe(false);
    expect(isValidSyncState({ ...base, records: [] })).toBe(false);

    // 顶层通过、嵌套结构坏掉 —— 这些正是会被持久化后才在物化时炸的形状
    expect(isValidSyncState({ ...base, records: { k: {} } })).toBe(false);
    expect(isValidSyncState({
      ...base,
      records: { k: { incarnations: { a: { ...incarnation, counters: undefined } }, tombstones: {} } },
    })).toBe(false);
    expect(isValidSyncState({
      ...base,
      records: { k: { incarnations: { a: { ...incarnation, stage: 'bogus' } }, tombstones: {} } },
    })).toBe(false);
    expect(isValidSyncState({
      ...base,
      records: { k: { incarnations: { a: { ...incarnation, aliases: { x: { text: 'y' } } } }, tombstones: {} } },
    })).toBe(false);
    expect(isValidSyncState({
      ...base,
      records: { k: { incarnations: {}, tombstones: { a: 123 } } },
    })).toBe(false);
    expect(isValidSyncState({ ...base, suppressed: { k: { text: 'x' } } })).toBe(false);
  });
});
