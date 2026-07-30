import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import { __testing } from '../maker-host/agent-resource-settings-store';

describe('agent resource settings store', () => {
  it('defaults to unlimited concurrency (0)', () => {
    expect(__testing.normalize(undefined).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({}).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize(null).maxConcurrentCommands).toBe(0);
  });

  it('preserves zero as the unlimited value', () => {
    expect(__testing.normalize({ maxConcurrentCommands: 0 }).maxConcurrentCommands).toBe(0);
  });

  it('floors and clamps the concurrency limit', () => {
    expect(__testing.normalize({ maxConcurrentCommands: 4.9 }).maxConcurrentCommands).toBe(4);
    expect(__testing.normalize({ maxConcurrentCommands: -3 }).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({ maxConcurrentCommands: 9999 }).maxConcurrentCommands).toBe(64);
  });

  it('falls back to default on non-numeric values', () => {
    expect(__testing.normalize({ maxConcurrentCommands: '5' }).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({ maxConcurrentCommands: Number.NaN }).maxConcurrentCommands).toBe(0);
    expect(
      __testing.normalize({ maxConcurrentCommands: Number.POSITIVE_INFINITY }).maxConcurrentCommands,
    ).toBe(0);
  });

  it('defaults process priority to normal and only accepts known tiers', () => {
    expect(__testing.normalize({}).processPriority).toBe('normal');
    expect(__testing.normalize({ processPriority: 'low' }).processPriority).toBe('low');
    expect(__testing.normalize({ processPriority: 'lowest' }).processPriority).toBe('lowest');
    expect(__testing.normalize({ processPriority: 'turbo' }).processPriority).toBe('normal');
    expect(__testing.normalize({ processPriority: 19 }).processPriority).toBe('normal');
  });

  it('defaults toolchain thread cap to off and only accepts literal true', () => {
    expect(__testing.normalize({}).capToolchainThreads).toBe(false);
    expect(__testing.normalize({ capToolchainThreads: true }).capToolchainThreads).toBe(true);
    expect(__testing.normalize({ capToolchainThreads: 'yes' }).capToolchainThreads).toBe(false);
    expect(__testing.normalize({ capToolchainThreads: 1 }).capToolchainThreads).toBe(false);
  });
});
