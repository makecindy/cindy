import { describe, expect, it } from 'vitest';

import type { ProviderUsageDayView, ProviderUsageHistoryView } from '../../../../shared/providerShare';
import {
  computerOrder,
  filterUsageRows,
  keysByTokens,
  modelKeyOf,
  rowsFromHistory,
  rowsFromLegacy,
  summarizeUsageRows,
  usageRowsByDay,
} from '../providerUsageStats';

const day = (partial: Partial<ProviderUsageDayView>): ProviderUsageDayView => ({
  day: '2026-10-17',
  kind: 'claude-code',
  providerId: 'xd',
  memberKey: 'local',
  model: 'opus',
  turns: 1,
  inputTokens: 10,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount: 1, currency: 'USD' },
  ...partial,
});

const history = (): ProviderUsageHistoryView => ({
  providerId: 'xd',
  todayKey: '2026-10-17',
  coverageStart: null,
  self: {
    lastUsedAt: 1,
    days: [
      day({}),
      day({ day: '2026-10-12', memberKey: 'device:studio:xd', inputTokens: 100, outputTokens: 0 }),
      day({ day: '2026-09-01', memberKey: null, model: 'sonnet' }),
    ],
  },
  relays: [{ deviceId: 'mini', deviceName: null, lastUsedAt: 1, days: [day({ inputTokens: 4, outputTokens: 0 })] }],
  members: [{ shareId: 's', memberId: 'm1', lastUsedAt: 1, days: [day({ day: '2026-10-16', memberKey: 'share:kai-1:xd' })] }],
});

describe('provider usage rows', () => {
  it('flattens daily usage by party and merges accounts on one physical computer', () => {
    const rows = rowsFromHistory(history(), new Map([['share:kai-1:xd', 'share-host:kai-pc']]));
    expect(rows.map((row) => [row.party, row.day, row.computer])).toEqual([
      ['self', '2026-10-17', 'local'],
      ['self', '2026-10-12', 'device:studio:xd'],
      ['self', '2026-09-01', null],
      ['member:m1', '2026-10-16', 'share-host:kai-pc'],
      ['relay:mini', '2026-10-17', 'local'],
    ]);
  });

  it('filters by period, person and computer, skipping the dimension a table lists', () => {
    const rows = rowsFromHistory(history());
    const filter = { range: '7d' as const, todayKey: '2026-10-17', party: 'self', computer: 'all' };
    expect(filterUsageRows(rows, filter).map((row) => row.day)).toEqual(['2026-10-17', '2026-10-12']);
    // 按人表不按使用方筛：所有人都在。
    expect(filterUsageRows(rows, filter, { party: true }).map((row) => row.party)).toEqual(['self', 'self', 'member:m1', 'relay:mini']);
    expect(filterUsageRows(rows, { ...filter, range: 'today', party: 'all', computer: 'local' }).map((row) => row.party))
      .toEqual(['self', 'relay:mini']);
    expect(filterUsageRows(rows, { ...filter, range: 'day:2026-09-01' })).toHaveLength(1);
    // 图表不按时间段筛。
    expect(filterUsageRows(rows, filter, { range: true })).toHaveLength(3);
  });

  it('sums tokens as input plus output, keeps cache hit rate and never adds amounts in different currencies', () => {
    const rows = rowsFromHistory(history());
    const totals = summarizeUsageRows([
      ...rows.slice(0, 2),
      { ...rows[0]!, cacheReadTokens: 30, inputTokens: 10, outputTokens: 0, amount: null },
    ]);
    expect(totals).toMatchObject({ tokens: 121, inputTokens: 120, turns: 3, amount: { amount: 2, currency: 'USD' } });
    expect(totals.cacheHitRate).toBeCloseTo(30 / 150);
    expect(summarizeUsageRows([rows[0]!, { ...rows[1]!, amount: { amount: 7, currency: 'CNY' } }]).amount).toBeNull();
    expect(summarizeUsageRows([]).cacheHitRate).toBeNull();
  });

  it('orders computers as the group lists them, then removed ones by usage, then earlier unattributed usage', () => {
    const rows = rowsFromHistory({
      ...history(),
      self: {
        lastUsedAt: 1,
        days: [
          day({ memberKey: 'device:gone:xd', inputTokens: 1 }),
          day({ memberKey: 'device:old:xd', inputTokens: 50 }),
          day({ memberKey: null }),
        ],
      },
      relays: [],
      members: [],
    });
    expect(computerOrder(['local', 'device:studio:xd'], rows)).toEqual([
      'local', 'device:studio:xd', 'device:old:xd', 'device:gone:xd', null,
    ]);
  });

  it('ranks models by tokens across the whole history and totals each day for the heatmap', () => {
    const rows = rowsFromHistory(history());
    expect(keysByTokens(rows, modelKeyOf)).toEqual(['claude-code opus', 'claude-code sonnet']);
    expect(usageRowsByDay(rows)).toEqual(expect.arrayContaining([
      { day: '2026-10-17', tokens: 15 },
      { day: '2026-10-12', tokens: 100 },
    ]));
  });

  it('turns an old computer’s all-time totals into undated rows that only count for all time', () => {
    const rows = rowsFromLegacy(
      {
        providerId: 'xd',
        local: { deviceId: null, deviceName: null, lastUsedAt: 1, models: [day({})] },
        devices: [{ deviceId: 'studio', deviceName: null, lastUsedAt: 1, models: [day({ memberKey: 'device:studio:xd' })] }],
        relays: [{ deviceId: 'mini', deviceName: null, lastUsedAt: 1, models: [day({})] }],
      },
      [],
    );
    expect(rows.map((row) => [row.party, row.day, row.computer])).toEqual([
      ['self', null, 'local'],
      ['self', null, 'device:studio:xd'],
      ['relay:mini', null, 'local'],
    ]);
    const filter = { range: 'all' as const, todayKey: '', party: 'all', computer: 'all' };
    expect(filterUsageRows(rows, filter)).toHaveLength(3);
    expect(filterUsageRows(rows, { ...filter, range: '7d' })).toHaveLength(0);
  });
});
