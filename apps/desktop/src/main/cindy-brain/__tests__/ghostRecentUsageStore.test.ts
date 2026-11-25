/**
 * Regression coverage for persisted Plugin recent-use ordering normalization.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadGhostRecentIdsAsync, normalizeGhostRecentIds } from '../ghostRecentUsageStore';

const scope = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(scope.dir, ...parts),
}));

describe('ghostRecentUsageStore', () => {
  it('keeps valid ids newest-first while removing invalid and duplicate values', () => {
    expect(
      normalizeGhostRecentIds([
        'cindy-github',
        '',
        'bad id',
        'xd-mivo',
        '_ns__acme__helper',
        'cindy-github',
        42,
      ]),
    ).toEqual(['cindy-github', 'xd-mivo', '_ns__acme__helper']);
  });

  it('bounds persisted history', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `plugin-${index}`);
    expect(normalizeGhostRecentIds(ids)).toEqual(ids.slice(0, 100));
  });
});

describe('asynchronous recent usage file reads', () => {
  beforeEach(async () => { scope.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recent-usage-')); });
  afterEach(async () => { await fs.rm(scope.dir, { recursive: true, force: true }); });

  it('reads the existing owner file in newest-first order', async () => {
    await fs.writeFile(path.join(scope.dir, 'ghost-recent-usage.json'), JSON.stringify({ ids: ['beta', 'alpha', 'beta'] }));
    await expect(loadGhostRecentIdsAsync()).resolves.toEqual(['beta', 'alpha']);
  });

  it('leaves a missing or oversized store untouched', async () => {
    await expect(loadGhostRecentIdsAsync()).resolves.toEqual([]);
    expect(await fs.readdir(scope.dir)).toEqual([]);
    const file = path.join(scope.dir, 'ghost-recent-usage.json');
    const oversized = JSON.stringify({ ids: ['alpha'], padding: 'x'.repeat(64 * 1024) });
    await fs.writeFile(file, oversized);
    await expect(loadGhostRecentIdsAsync()).resolves.toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe(oversized);
  });
});
