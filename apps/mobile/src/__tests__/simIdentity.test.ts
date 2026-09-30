import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSimEnvironment } from '../../scripts/lib/sim-environment.mjs';
import { describe, expect, it } from 'vitest';
import { validateSimMetroIdentity, resolveSimMetroHandoff } from '../../scripts/lib/sim-whoami.mjs';

const fresh = {
  listener: { confirmed: true, isTarget: true },
  currentSource: 'main@123', runningSource: 'main@123',
  currentRegion: 'global', runningRegion: 'global',
  currentEnvFingerprint: 'env1', runningEnvFingerprint: 'env1',
};

describe('shared simulator identity', () => {
  it.each([
    [{}, 'target-fresh'],
    [{ listener: null }, 'occupied-unknown'],
    [{ listener: { confirmed: true, isTarget: false } }, 'occupied-foreign'],
    [{ runningSource: 'old' }, 'target-stale'],
    [{ currentSource: null, runningSource: null }, 'target-stale'],
    [{ runningRegion: 'cn' }, 'target-region-stale'],
    [{ runningRegion: undefined }, 'target-region-stale'],
    [{ runningEnvFingerprint: 'old' }, 'target-env-stale'],
    [{ runningEnvFingerprint: undefined }, 'target-env-stale'],
    [{ envChanged: true }, 'target-env-stale'],
  ])('shares freshness with the start handoff: %j', (override, code) => {
    const input = { ...fresh, ...override };
    const verdict = validateSimMetroIdentity(input);
    expect(verdict).toEqual({ healthy: code === 'target-fresh', code });
    expect(resolveSimMetroHandoff({ ...input, listenerWorktreeExists: true }).action)
      .toBe(verdict.healthy ? 'reuse' : 'refuse');
  });
  it('only permits explicit takeover to restart a stale environment', () => {
    expect(resolveSimMetroHandoff({ ...fresh, runningRegion: 'cn', takeover: true }).action).toBe('restart');
    expect(validateSimMetroIdentity({ ...fresh, runningRegion: 'cn' }).healthy).toBe(false);
  });
});


describe('shared simulator environment', () => {
  it('reads missing files without creating them and notices changed dotenv inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cindy-sim-env-'));
    try {
      const before = readSimEnvironment(dir, {});
      const file = join(dir, '.env');
      writeFileSync(file, 'EXPO_PUBLIC_TEST_VALUE=one\n');
      const first = readSimEnvironment(dir, {});
      expect(first.envFingerprint).not.toBe(before.envFingerprint);
      expect(readSimEnvironment(dir, {}).envFingerprint).toBe(first.envFingerprint);
      writeFileSync(file, 'EXPO_PUBLIC_TEST_VALUE=two\n');
      expect(readSimEnvironment(dir, {}).envFingerprint).not.toBe(first.envFingerprint);
      expect(readFileSync(file, 'utf8')).toBe('EXPO_PUBLIC_TEST_VALUE=two\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
