import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(owner.dir, ...parts),
}));

import {
  createProviderPartyUsageStore,
  currentProviderPartyUsageStore,
  flushProviderPartyUsage,
} from '../providerPartyUsageStore';

const sample = (model: string, input: number, output: number, turns = 1) => ({
  model, turns, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
});

const reportRow = (day: string, memberKey: string, input: number) => ({
  day, providerId: 'anthropic', memberKey, kind: 'claude-code', model: 'opus',
  turns: 1, inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
  lastAt: new Date(`${day}T12:00:00`).getTime(),
});

describe('provider party usage store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-party-usage-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splits one provider into this computer and each other computer, by range and by computer in the group', async () => {
    let now = new Date(2026, 9, 7, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderPartyUsageStore(file, { now: () => now });
    expect(store.record({ kind: 'local' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 5)] }))
      .toBe('2026-10-07');
    // 同一个模型在组里另一台运行：分开记。
    store.record({ kind: 'local' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:anthropic-2', samples: [sample('opus', 3, 1)] });
    store.record({ kind: 'device', deviceId: 'studio' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 7, 3)] });
    store.record({ kind: 'relay', deviceId: 'mini' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 2, 2)] });
    // 别的供应商不混进来。
    store.record({ kind: 'local' }, { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });
    now = new Date(2026, 8, 20, 12).getTime();
    store.record({ kind: 'local' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 100, 50)] });
    now = new Date(2026, 9, 7, 13).getTime();

    const month = store.query('anthropic', 'month');
    expect(month.local).toMatchObject({ deviceId: null, lastUsedAt: new Date(2026, 9, 7, 12).getTime() });
    expect(month.local?.models).toEqual([
      { kind: 'claude-code', model: 'opus', memberKey: 'local', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 },
      { kind: 'claude-code', model: 'opus', memberKey: 'device:studio:anthropic-2', turns: 1, inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 },
    ]);
    expect(month.devices).toHaveLength(1);
    expect(month.devices[0]).toMatchObject({ deviceId: 'studio' });
    // 替受邀者转来的单独一项，不算进我的其他电脑。
    expect(month.relays).toEqual([expect.objectContaining({ deviceId: 'mini' })]);
    expect(store.query('anthropic', 'all').local?.models[0]).toMatchObject({ memberKey: 'local', turns: 2, inputTokens: 110, outputTokens: 55 });
    expect(store.query('xai', 'all')).toEqual({ local: null, devices: [], relays: [] });

    await store.flush();
    const reloaded = createProviderPartyUsageStore(file, { now: () => now });
    expect(reloaded.query('anthropic', 'all').devices[0]?.models[0]).toMatchObject({ inputTokens: 7 });
    expect(reloaded.query('openai', 'all').local?.models[0]).toMatchObject({ model: 'gpt' });
  });

  it('reads rows written before parties and group computers were recorded', () => {
    const file = path.join(dir, 'usage.json');
    const old = (deviceId: string | null) => ({
      day: '2026-10-11', providerId: 'p', deviceId, kind: 'pi', model: 'x', turns: 1,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
    });
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [old(null), old('studio')] }));
    const result = createProviderPartyUsageStore(file).query('p', 'all');
    expect(result.local?.models[0]).toMatchObject({ memberKey: null, turns: 1 });
    expect(result.devices[0]).toMatchObject({ deviceId: 'studio' });
  });

  it('ignores rounds without a provider and malformed rows', () => {
    const file = path.join(dir, 'usage.json');
    const store = createProviderPartyUsageStore(file);
    expect(store.record({ kind: 'local' }, { kind: 'pi', providerId: '', memberKey: 'local', samples: [sample('x', 1, 1)] })).toBeNull();
    expect(store.query('', 'all')).toEqual({ local: null, devices: [], relays: [] });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [
        { day: '2026-10-01', providerId: 'p', deviceId: '', kind: 'pi', model: 'x', turns: 1 },
        // 本机的行不能带设备，其他电脑的行必须带设备。
        { day: '2026-10-01', providerId: 'p', party: 'local', deviceId: 'x', memberKey: 'local', kind: 'pi', model: 'x', turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1 },
        { day: '2026-10-01', providerId: 'p', party: 'nobody', deviceId: 'x', memberKey: 'local', kind: 'pi', model: 'x', turns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1 },
      ],
    }));
    expect(createProviderPartyUsageStore(file).query('p', 'all')).toEqual({ local: null, devices: [], relays: [] });
  });

  it('keeps usage to report to another group separately and shows reported usage under that computer', () => {
    const file = path.join(dir, 'usage.json');
    const now = new Date(2026, 9, 11, 9).getTime();
    const store = createProviderPartyUsageStore(file, { now: () => now });
    // 这台电脑经 mini 的组、在组里的 studio 上运行：只用来报告给 mini，不算进本机的 anthropic。
    store.record({ kind: 'group', deviceId: 'mini' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 40, 2)] });
    expect(store.query('anthropic', 'all')).toEqual({ local: null, devices: [], relays: [] });
    expect(store.groupOwners()).toEqual(['mini']);
    expect(store.groupReport('mini', null)).toEqual([
      expect.objectContaining({ day: '2026-10-11', providerId: 'anthropic', memberKey: 'device:studio:a2', inputTokens: 40 }),
    ]);
    // 报告端与组所在电脑可能跨时区，边界前两天也要带上供接收端按时间戳归一。
    expect(store.groupReport('mini', '2026-10-12')).toHaveLength(1);
    expect(store.groupReport('mini', '2026-10-14')).toEqual([]);
    expect(store.groupReport('other', null)).toEqual([]);

    // 组所在电脑这边：laptop 报来的整体替换它从那天起的行，并进 laptop 那台。
    store.record({ kind: 'device', deviceId: 'laptop' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 1, 1)] });
    store.replaceReported('laptop', null, [reportRow('2026-10-09', 'device:studio:a2', 5), reportRow('2026-10-10', 'device:studio:a2', 6)]);
    store.replaceReported('laptop', '2026-10-10', [reportRow('2026-10-10', 'device:studio:a2', 8)]);
    const laptop = store.query('anthropic', 'all').devices;
    expect(laptop).toHaveLength(1);
    expect(laptop[0]?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberKey: 'local', inputTokens: 1 }),
      expect.objectContaining({ memberKey: 'device:studio:a2', inputTokens: 8 }),
    ]));
    // 再报一次同样的一份不会多算。
    store.replaceReported('laptop', '2026-10-10', [reportRow('2026-10-10', 'device:studio:a2', 8)]);
    expect(store.query('anthropic', 'all').devices[0]?.models.find((model) => model.memberKey !== 'local')).toMatchObject({ inputTokens: 8 });
  });

  // 「用量」块按天筛选(provider-groups.md §7)：你自己(本机、我的其他电脑与报告来的)合成一份，转来的按那台分开。
  it('lists daily usage for one provider with you combined across your computers and relays kept apart', () => {
    const file = path.join(dir, 'usage.json');
    let now = new Date(2026, 9, 10, 9).getTime();
    const store = createProviderPartyUsageStore(file, { now: () => now });
    store.record({ kind: 'local' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    now = new Date(2026, 9, 11, 9).getTime();
    store.record({ kind: 'local' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 20, 2)] });
    store.record({ kind: 'device', deviceId: 'studio' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 5, 5)] });
    store.record({ kind: 'relay', deviceId: 'mini' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 2, 2)] });
    // 要报告给另一台的组的不算；别的供应商不混进来。
    store.record({ kind: 'group', deviceId: 'mini' }, { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 40, 2)] });
    store.record({ kind: 'local' }, { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });
    store.replaceReported('laptop', null, [reportRow('2026-10-11', 'device:studio:a2', 6)]);

    const history = store.history('anthropic');
    // 新的日子在前；本机与 studio 同一天、同一台组内电脑的合成一行。
    expect(history.self.days.map((row) => [row.day, row.memberKey, row.turns, row.inputTokens])).toEqual([
      ['2026-10-11', 'local', 2, 25],
      ['2026-10-11', 'device:studio:a2', 1, 6],
      ['2026-10-10', 'local', 1, 10],
    ]);
    // 报告行的 lastAt 由接收端按本地时区归一；这份 fixture 的报告时刻是当天 12 点。
    expect(history.self.lastUsedAt).toBe(new Date(2026, 9, 11, 12).getTime());
    expect(history.relays).toEqual([
      expect.objectContaining({ deviceId: 'mini', days: [expect.objectContaining({ day: '2026-10-11', inputTokens: 2 })] }),
    ]);
    expect(store.history('xai')).toEqual({ self: { lastUsedAt: null, days: [] }, relays: [] });
  });

  it('normalizes reported history to the receiving computer local day', () => {
    const store = createProviderPartyUsageStore(path.join(dir, 'timezone.json'));
    const row = reportRow('2026-10-10', 'device:studio:a2', 6);
    row.lastAt = new Date(2026, 9, 11, 0, 30).getTime();
    store.replaceReported('laptop', null, [row]);
    expect(store.history('anthropic').self.days[0]?.day).toBe('2026-10-11');
  });

  it('keeps one ledger per account', async () => {
    owner.dir = path.join(dir, 'owner-a');
    currentProviderPartyUsageStore().record({ kind: 'local' }, { kind: 'pi', providerId: 'anthropic', memberKey: 'local', samples: [sample('m', 1, 1)] });
    owner.dir = path.join(dir, 'owner-b');
    expect(currentProviderPartyUsageStore().query('anthropic', 'all').local).toBeNull();
    await flushProviderPartyUsage();
    expect(fs.existsSync(path.join(dir, 'owner-a', 'provider-usage-by-party.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'owner-b', 'provider-usage-by-party.json'))).toBe(false);
  });
});
