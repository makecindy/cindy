import { describe, expect, it } from 'vitest';
import { parseMakeDependencyProgress } from '../sourcePnpm.js';

describe('dependency progress projection', () => {
  it('keeps the actual counters when pnpm moves into installation scripts', () => {
    const counters = { resolved: 12, reused: 8, downloaded: 4, added: 12 };
    expect(
      parseMakeDependencyProgress(
        'apps/desktop postinstall$ node install.js\nprivate output',
        counters,
      ),
    ).toEqual({ ...counters, activity: 'scripts' });
  });
  it('returns the latest real pnpm counts without leaking raw output', () => {
    expect(
      parseMakeDependencyProgress(
        'private path and credentials\nProgress: resolved 12, reused 4, downloaded 6, added 2\nProgress: resolved 30, reused 14, downloaded 16, added 20',
      ),
    ).toEqual({ resolved: 30, reused: 14, downloaded: 16, added: 20 });
  });
  it('does not invent a percentage or counters from other output', () => {
    expect(parseMakeDependencyProgress('apps/desktop postinstall$ node install.js')).toEqual({
      activity: 'scripts',
    });
    expect(parseMakeDependencyProgress('Downloading package: 42%')).toBeUndefined();
    expect(
      parseMakeDependencyProgress('Progress: resolved 2, reused 1, downloaded'),
    ).toBeUndefined();
  });
});
