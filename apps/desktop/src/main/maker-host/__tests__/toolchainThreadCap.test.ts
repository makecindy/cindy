import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
  },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  computeToolchainThreadCapEnv,
  recommendedToolchainThreads,
} from '../toolchain-thread-cap';

describe('recommendedToolchainThreads', () => {
  it('gives half the cores for normal/low and a quarter for lowest', () => {
    expect(recommendedToolchainThreads('normal', 10)).toBe(5);
    expect(recommendedToolchainThreads('low', 10)).toBe(5);
    expect(recommendedToolchainThreads('lowest', 10)).toBe(3);
  });

  it('never goes below 1', () => {
    expect(recommendedToolchainThreads('lowest', 1)).toBe(1);
    expect(recommendedToolchainThreads('low', 1)).toBe(1);
  });
});

describe('computeToolchainThreadCapEnv', () => {
  it('returns an empty object when the cap is disabled', () => {
    expect(
      computeToolchainThreadCapEnv(
        { capToolchainThreads: false, processPriority: 'lowest' },
        {},
        10,
      ),
    ).toEqual({});
  });

  it('injects the full variable set when enabled (POSIX)', () => {
    expect(
      computeToolchainThreadCapEnv(
        { capToolchainThreads: true, processPriority: 'normal' },
        {},
        8,
        'darwin',
      ),
    ).toEqual({
      VITEST_MAX_FORKS: '4',
      VITEST_MAX_THREADS: '4',
      MAKEFLAGS: '-j4',
      CARGO_BUILD_JOBS: '4',
    });
  });

  it('skips MAKEFLAGS on Windows (nmake rejects GNU -j syntax)', () => {
    const out = computeToolchainThreadCapEnv(
      { capToolchainThreads: true, processPriority: 'normal' },
      {},
      8,
      'win32',
    );
    expect(out.MAKEFLAGS).toBeUndefined();
    expect(out.VITEST_MAX_FORKS).toBe('4');
    expect(out.CARGO_BUILD_JOBS).toBe('4');
  });

  it('never overrides variables the user already has in the base env', () => {
    const out = computeToolchainThreadCapEnv(
      { capToolchainThreads: true, processPriority: 'normal' },
      { MAKEFLAGS: '-j16', VITEST_MAX_FORKS: '9' },
      8,
      'darwin',
    );
    expect(out).toEqual({
      VITEST_MAX_THREADS: '4',
      CARGO_BUILD_JOBS: '4',
    });
  });

  it('uses the lowest-tier divisor when priority is lowest', () => {
    const out = computeToolchainThreadCapEnv(
      { capToolchainThreads: true, processPriority: 'lowest' },
      {},
      8,
      'darwin',
    );
    expect(out.VITEST_MAX_FORKS).toBe('2');
    expect(out.MAKEFLAGS).toBe('-j2');
  });
});
