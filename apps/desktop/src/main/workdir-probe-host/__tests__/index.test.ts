import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  probe: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { once: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
}));

vi.mock('../MainProcessWorkdirProbeClient.js', () => ({
  MainProcessWorkdirProbeClient: vi.fn(() => mocks),
}));

import { statWorkingDirectory } from '../index.js';

describe('workdir probe wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probe.mockResolvedValue({ ok: true, isDirectory: true });
  });

  it('normalizes equivalent paths before single-flight deduplication', async () => {
    const dir = path.join('relative', '..', 'workspace');

    await expect(statWorkingDirectory(dir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    expect(mocks.probe).toHaveBeenCalledWith(dir, path.resolve(dir), 5_000, 'probe');
  });
});
