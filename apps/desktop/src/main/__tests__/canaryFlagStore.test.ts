import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSync = vi.hoisted(() => vi.fn(() => JSON.stringify({ canary: true })));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/cindy-test') },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual, readFileSync },
    readFileSync,
  };
});

vi.mock('../logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

import * as canaryFlagStore from '../canaryFlagStore';

describe('canaryFlagStore process override', () => {
  beforeEach(() => {
    readFileSync.mockClear();
    readFileSync.mockReturnValue(JSON.stringify({ canary: true }));
    canaryFlagStore.setProcessOverride(null);
  });

  it('uses a process-only stable override without modifying the saved account flag', () => {
    expect(canaryFlagStore.read()).toBe(true);
    expect(readFileSync).toHaveBeenCalledTimes(1);

    canaryFlagStore.setProcessOverride(false);
    expect(canaryFlagStore.read()).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(1);

    canaryFlagStore.setProcessOverride(null);
    expect(canaryFlagStore.read()).toBe(true);
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
