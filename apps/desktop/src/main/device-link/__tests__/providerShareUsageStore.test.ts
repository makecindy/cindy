import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProviderShareUsageStore, providerShareUsageRangeStart } from '../providerShareUsageStore';

const sample = (model: string, input: number, output: number, turns = 1) => ({
  model, turns, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
});

describe('provider share usage store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-usage-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Unit, real ledger entry: personal ratios must isolate identity/provider/date and exclude cache.
  // Existing range tests do not cover midnight recovery or a failed ledger becoming a false 0%.
  it('reconstructs only one member/provider over seven local dates and advances at midnight', async () => {
    let now = new Date(2026, 9, 22, 10).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    const write = (share: string, member: string, provider: string, model: string, tokens: number) =>
      store.record(share, member, { kind: 'codex', providerId: provider, memberKey: 'local', samples: [{ ...sample(model, tokens, 0), cacheReadTokens: 99999 }] });
    write('s', 'alice', 'p', 'new-model', 60);
    write('s', 'bob', 'p', 'new-model', 900);
    write('s', 'alice', 'another-provider', 'new-model', 900);
    write('another-share', 'alice', 'p', 'new-model', 900);
    now = new Date(2026, 9, 28, 10).getTime();
    write('s', 'alice', 'p', 'other-model', 40);
    const current = store.memberTokenSnapshot(new Set(['s']), 'p', 'alice');
    expect(current).toMatchObject({ available: true, windowStart: '2026-10-22', windowEnd: '2026-10-28',
      models: [{ model: 'new-model', tokens: 60 }, { model: 'other-model', tokens: 40 }] });
    now = current.nextWindowAt;
    expect(store.memberTokenSnapshot(new Set(['s']), 'p', 'alice')).toMatchObject({ windowStart: '2026-10-23', models: [{ model: 'other-model', tokens: 40 }] });
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).memberTokenSnapshot(new Set(['s']), 'p', 'alice').models).toEqual([{ model: 'other-model', tokens: 40 }]);
  });
  it('marks corrupt usage unavailable across subsequent writes and reloads', async () => {
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{broken');
    const store = createProviderShareUsageStore(file);
    expect(store.memberTokenSnapshot(new Set(['s']), 'p', 'alice').available).toBe(false);
    store.record('s', 'alice', { kind: 'codex', providerId: 'p', memberKey: 'local', samples: [sample('model', 1, 0)] });
    await store.flush();
    expect(createProviderShareUsageStore(file).memberTokenSnapshot(new Set(['s']), 'p', 'alice').available).toBe(false);
  });

  // Unit: production snapshot/flush/reload must stop pausing once missing data leaves the window.
  // Regression #7666/r4398894972: the prior corrupt-file case only checked fail-closed, not recovery.
  // Minimal input: one corruption marker, a complete new row, restart next day, then advance seven dates.
  it.each(['corrupt-json', 'legacy-marker', 'dated-invalid-row'] as const)(
    'recovers after incomplete data leaves seven local dates, including reloads (%s)', async (damage) => {
      let now = new Date(2026, 9, 22, 12).getTime();
      const file = path.join(dir, 'usage.json');
      fs.writeFileSync(file, damage === 'corrupt-json' ? '{broken' : JSON.stringify({ version: 1,
        rows: damage === 'dated-invalid-row' ? [{ day: '2026-10-21', inputTokens: -1 }] : [],
        ...(damage === 'legacy-marker' ? { incomplete: true } : {}),
      }));
      let store = createProviderShareUsageStore(file, { now: () => now });
      const snapshot = () => store.memberTokenSnapshot(new Set(['s']), 'p', 'alice');
      expect(snapshot().available).toBe(false);
      await store.flush();
      now = new Date(2026, 9, 23, 12).getTime();
      store = createProviderShareUsageStore(file, { now: () => now });
      expect(snapshot().available).toBe(false);
      store.record('s', 'alice', { kind: 'codex', providerId: 'p', memberKey: 'local', samples: [sample('model', 10, 5)] });
      await store.flush();
      now = new Date(2026, 9, damage === 'dated-invalid-row' ? 28 : 29, 12).getTime();
      store = createProviderShareUsageStore(file, { now: () => now });
      expect(snapshot()).toMatchObject({ available: true, models: [{ model: 'model', tokens: 15 }] });
    },
  );

  it('aggregates per member and model, filters by range and only returns requested shares', async () => {
    let now = new Date(2026, 9, 7, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 5)] });
    now = new Date(2026, 8, 20, 12).getTime();
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 100, 50)] });
    store.record('share-2', 'm9', { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });
    now = new Date(2026, 9, 7, 13).getTime();

    const month = store.query(new Set(['share-1']), 'month');
    expect(month).toHaveLength(1);
    expect(month[0]).toMatchObject({ shareId: 'share-1', memberId: 'm1' });
    expect(month[0].models).toEqual([{ kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', model: 'opus', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
    expect(month[0].lastUsedAt).toBe(new Date(2026, 9, 7, 12).getTime());
    expect(store.query(new Set(['share-1']), 'all')[0].models[0]).toMatchObject({ turns: 2, inputTokens: 110, outputTokens: 55 });

    await store.flush();
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['share-1', 'share-2']), 'all')).toHaveLength(2);
  });

  it('splits each row by computer in the group without changing the row key, so older versions keep the totals', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    // 加组内电脑之前记的一行：合计 3 轮，没有区分电脑。
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [{
        day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
        turns: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0.3, lastAt: 1,
      }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 20, 2)] });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.map((model) => [model.memberKey, model.turns, model.inputTokens])).toEqual(
      expect.arrayContaining([['local', 1, 10], ['device:studio:a2', 1, 20], [null, 3, 30]]),
    );
    expect(models).toHaveLength(3);

    // 文件里仍是同一行(旧版本的键)，合计包含全部；各台的分布在 byMember 里。
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<Record<string, unknown>> };
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ turns: 5, inputTokens: 60, byMember: { local: { turns: 1 }, 'device:studio:a2': { turns: 1 } } });

    // 降级期间旧版本只加了合计：多出来的算没区分电脑，不会让某台超过合计。
    saved.rows[0]!.turns = 7;
    saved.rows[0]!.inputTokens = 80;
    fs.writeFileSync(file, JSON.stringify(saved));
    const after = createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')[0]!.models;
    expect(after.find((model) => model.memberKey === null)).toMatchObject({ turns: 5, inputTokens: 50 });
  });

  // 「用量」块按天筛选(provider-groups.md §7)：每天按组内电脑拆开，拆法与 query 相同。
  it('lists daily usage per member split by computer, newest day first and only for requested shares', () => {
    let now = new Date(2026, 9, 10, 12).getTime();
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [{
        day: '2026-10-09', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
        turns: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
      }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 20, 2)] });
    now = new Date(2026, 9, 11, 12).getTime();
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 5, 5)] });
    store.record('other', 'x', { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });

    const history = store.history(new Set(['s']));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ shareId: 's', memberId: 'm', lastUsedAt: now });
    expect(history[0]!.days.map((row) => [row.day, row.memberKey, row.inputTokens])).toEqual([
      ['2026-10-11', 'local', 5],
      ['2026-10-10', 'local', 10],
      ['2026-10-10', 'device:studio:a2', 20],
      // 加组内电脑之前记的：没有区分电脑。
      ['2026-10-09', null, 30],
    ]);
  });

  it('bounds daily expansion before splitting every stored computer distribution', () => {
    let now = new Date(2026, 9, 12, 12).getTime();
    const file = path.join(dir, 'bounded-history.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:new', samples: [sample('new', 1, 1)] });
    now = new Date(2026, 9, 11, 12).getTime();
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:old', samples: [sample('old', 1, 1)] });
    const history = store.history(new Set(['s']), { maxRows: 1 });
    expect(history[0]).toMatchObject({ shareId: 's', memberId: 'm', lastUsedAt: new Date(2026, 9, 12, 12).getTime() });
    expect(history[0]?.days).toHaveLength(1);
    expect(history[0]?.days[0]).toMatchObject({ day: '2026-10-12', model: 'new', memberKey: 'device:new' });
  });

  it('applies the split-row budget across members after excluding removed members', () => {
    let now = new Date(2026, 9, 10, 12).getTime();
    const store = createProviderShareUsageStore(path.join(dir, 'split-history.json'), { now: () => now });
    const record = (memberId: string, memberKey: string) => store.record('s', memberId, {
      kind: 'claude-code', providerId: 'anthropic', memberKey, samples: [sample('opus', 1, 1)],
    });
    record('m', 'device:old');
    now = new Date(2026, 9, 11, 12).getTime();
    for (let index = 0; index < 512; index++) record('m', `device:d${index}`);
    now = new Date(2026, 9, 12, 12).getTime();
    record('removed', 'local');
    const history = store.history(new Set(['s']), {
      maxRows: 3, memberKeys: new Set([JSON.stringify(['s', 'm'])]),
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.days).toHaveLength(3);
    expect(history[0]?.days.every((row) => row.day === '2026-10-11')).toBe(true);
    expect(history[0]?.days.map((row) => row.memberKey)).toEqual(['device:d0', 'device:d1', 'device:d2']);
    expect(history[0]?.lastUsedAt).toBe(new Date(2026, 9, 11, 12).getTime());
  });

  it('keeps existing computer distributions and all counters after exceeding the per-row capacity and restarting', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    const usage = (memberKey: string, turns = 1) => ({
      kind: 'claude-code', providerId: 'anthropic', memberKey, samples: [{
        ...sample('opus', turns * 10, turns * 5, turns),
        cacheReadTokens: turns * 2, cacheCreateTokens: turns * 3, sdkCostUsd: turns * 0.01,
      }],
    });
    for (let i = 0; i < 512; i++) store.record('s', 'm', usage(`device:d${i}:anthropic`));
    store.record('s', 'm', usage('device:overflow:anthropic', 2));
    // 满容量后已有键仍能更新，不能因为新键溢出而丢掉已记的电脑。
    store.record('s', 'm', usage('device:d0:anthropic', 3));
    const before = store.query(new Set(['s']), 'all');
    expect(before[0]!.models).toHaveLength(513);
    expect(before[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 4 });
    expect(before[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 2, inputTokens: 20 });
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.byMember).not.toHaveProperty('device:overflow:anthropic');
    expect(saved.rows[0]!.turns).toBe(517);
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['s']), 'all')).toEqual(before);
    const models = before[0]!.models;
    for (const [field, total] of [
      ['turns', 517], ['inputTokens', 5170], ['outputTokens', 2585],
      ['cacheReadTokens', 1034], ['cacheCreateTokens', 1551], ['sdkCostUsd', 5.17],
    ] as const) {
      expect(models.reduce((sum, model) => sum + model[field], 0)).toBeCloseTo(total);
    }
    reloaded.record('s', 'm', usage('device:overflow:anthropic'));
    reloaded.record('s', 'm', usage('device:d511:anthropic'));
    const after = reloaded.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 3 });
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d511:anthropic')).toMatchObject({ turns: 2 });
    await reloaded.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
  });

  it('recovers the stored distributions from an older oversized byMember row without losing its total', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const counters = { turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{
      day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
      ...counters, turns: 513, inputTokens: 5130, outputTokens: 2565, lastAt: now,
      byMember: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`device:d${i}:anthropic`, counters])),
    }] }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.filter((model) => model.memberKey !== null)).toHaveLength(512);
    expect(models.find((model) => model.memberKey === null)).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 5 });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:d0:anthropic', samples: [sample('opus', 20, 10, 2)] });
    const after = store.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 3 });
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.turns).toBe(515);
  });

  it('starts from an empty ledger when the file is corrupt and drops malformed rows', () => {
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{not json');
    expect(createProviderShareUsageStore(file).query(new Set(['s']), 'all')).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ day: '2026-10-01', shareId: 's', memberId: 'm', kind: 'pi', providerId: null, model: 'x', turns: -1 }] }));
    expect(createProviderShareUsageStore(file).query(new Set(['s']), 'all')).toEqual([]);
  });

  it('computes range starts in local days', () => {
    const now = new Date(2026, 9, 7, 9).getTime();
    expect(providerShareUsageRangeStart('all', now)).toBeNull();
    expect(providerShareUsageRangeStart('month', now)).toBe('2026-10-01');
    expect(providerShareUsageRangeStart('7d', now)).toBe('2026-10-01');
  });
});
