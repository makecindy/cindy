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

  it('aggregates per member and model, filters by range and only returns requested shares', async () => {
    let now = new Date(2026, 9, 7, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', samples: [sample('opus', 10, 5)] });
    now = new Date(2026, 8, 20, 12).getTime();
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', samples: [sample('opus', 100, 50)] });
    store.record('share-2', 'm9', { kind: 'codex', providerId: 'openai', samples: [sample('gpt', 1, 1)] });
    now = new Date(2026, 9, 7, 13).getTime();

    const month = store.query(new Set(['share-1']), 'month');
    expect(month).toHaveLength(1);
    expect(month[0]).toMatchObject({ shareId: 'share-1', memberId: 'm1' });
    expect(month[0].models).toEqual([{ kind: 'claude-code', providerId: 'anthropic', model: 'opus', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
    expect(month[0].lastUsedAt).toBe(new Date(2026, 9, 7, 12).getTime());
    expect(store.query(new Set(['share-1']), 'all')[0].models[0]).toMatchObject({ turns: 2, inputTokens: 110, outputTokens: 55 });

    await store.flush();
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['share-1', 'share-2']), 'all')).toHaveLength(2);
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
