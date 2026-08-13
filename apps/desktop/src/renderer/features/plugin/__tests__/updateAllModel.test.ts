/**
 * Unit coverage for the update-all batch model: row extraction, transitions,
 * settlement predicates, and the ignore-round identity key.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import {
  batchSummary,
  buildUpdateAllRows,
  ignoredRoundStorageKey,
  isBatchFinished,
  isBatchSettled,
  updateRoundKey,
  updateRow,
} from '../lib/updateAllModel';

function marketItem(overrides: Partial<PluginMarketItem>): PluginMarketItem {
  return {
    pluginId: 'release-a',
    ghostId: 'ghost-a',
    name: 'Ghost A',
    description: '',
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: 'release-1',
    version: '1.1.0',
    publishedAt: '2026-08-01T00:00:00.000Z',
    icon: null,
    installState: 'update-available',
    enabled: true,
    sourceType: 'server',
    sourceMarketName: null,
    ...overrides,
  };
}

describe('buildUpdateAllRows', () => {
  it('extracts only update-available items and keeps snapshot order', () => {
    const rows = buildUpdateAllRows(
      [
        marketItem({ pluginId: 'p1', ghostId: 'g1', version: '2.0.0' }),
        marketItem({ pluginId: 'p2', ghostId: 'g2', installState: 'installed' }),
        marketItem({ pluginId: 'p3', ghostId: 'g3', installState: 'not-installed' }),
        marketItem({ pluginId: 'p4', ghostId: 'g4', version: '0.2.0' }),
      ],
      new Map([
        ['g1', '1.0.0'],
        ['g4', '0.1.0'],
      ]),
    );

    expect(rows.map((row) => row.pluginId)).toEqual(['p1', 'p4']);
    expect(rows[0]).toMatchObject({
      ghostId: 'g1',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      status: 'pending',
    });
  });
});

describe('batch transitions', () => {
  const rows = buildUpdateAllRows(
    [
      marketItem({ pluginId: 'p1', ghostId: 'g1' }),
      marketItem({ pluginId: 'p2', ghostId: 'g2' }),
    ],
    new Map(),
  );

  it('updates a single row immutably', () => {
    const next = updateRow(rows, 'p1', { status: 'done' });
    expect(next[0].status).toBe('done');
    expect(rows[0].status).toBe('pending');
    expect(next[1].status).toBe('pending');
  });

  it('finishes only after every row reaches a terminal state, including needs-confirm', () => {
    let next = updateRow(rows, 'p1', { status: 'done' });
    next = updateRow(next, 'p2', { status: 'installing' });
    expect(isBatchFinished(next)).toBe(false);

    next = updateRow(next, 'p2', { status: 'needs-confirm' });
    expect(isBatchSettled(next)).toBe(true);
    expect(isBatchFinished(next)).toBe(false);

    next = updateRow(next, 'p2', { status: 'skipped' });
    expect(isBatchFinished(next)).toBe(true);
    expect(batchSummary(next)).toEqual({ done: 1, skipped: 1, failed: 0 });
  });
});

describe('updateRoundKey', () => {
  it('is stable across ordering and changes when any target version changes', () => {
    const a = [
      marketItem({ pluginId: 'p1', ghostId: 'g1', version: '1.1.0' }),
      marketItem({ pluginId: 'p2', ghostId: 'g2', version: '2.0.0' }),
    ];
    const b = [a[1], a[0]];
    expect(updateRoundKey(a)).toBe(updateRoundKey(b));
    const c = [a[0], marketItem({ pluginId: 'p2', ghostId: 'g2', version: '2.0.1' })];
    expect(updateRoundKey(c)).not.toBe(updateRoundKey(a));
    // 非可更新项不参与身份键。
    expect(
      updateRoundKey([...a, marketItem({ ghostId: 'g9', installState: 'installed' })]),
    ).toBe(updateRoundKey(a));
  });
});

describe('ignoredRoundStorageKey', () => {
  it('isolates the ignore state per data owner and mode', () => {
    const cloudA = ignoredRoundStorageKey('cloud', 'owner-a');
    const cloudB = ignoredRoundStorageKey('cloud', 'owner-b');
    const local = ignoredRoundStorageKey('local', null);

    // 账号 A 忽略本轮,不得静默压掉账号 B 或本地模式的更新横幅。
    expect(new Set([cloudA, cloudB, local]).size).toBe(3);
    expect(ignoredRoundStorageKey('cloud', 'owner-a')).toBe(cloudA);
    // 未登录/本地无 owner 时也有稳定桶,不回落到共享键。
    expect(local).toContain('anonymous');
  });
});
