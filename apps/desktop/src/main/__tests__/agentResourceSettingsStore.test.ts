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
});
