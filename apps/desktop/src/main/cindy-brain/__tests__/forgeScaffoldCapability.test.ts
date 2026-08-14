import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork },
}));

import { writeForgeScaffoldWithStableParent } from '../forgeScaffoldCapability';

class FakeUtilityProcess extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn();
  postMessage = vi.fn();
}

const request = {
  parentDir: 'C:\\plugin-parent',
  targetName: 'demo-plugin',
  expectedParent: {
    realPath: 'C:\\plugin-parent',
    dev: 1n,
    ino: 2n,
  },
  files: [],
};

describe('writeForgeScaffoldWithStableParent', () => {
  beforeEach(() => {
    mocks.fork.mockReset();
  });

  it('fails immediately when the worker exits cleanly before returning a result', async () => {
    const child = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(child);

    const result = writeForgeScaffoldWithStableParent(request);
    child.emit('exit', 0);

    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'Forge scaffold worker exited (0)',
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('reports worker stderr when exit happens before a result', async () => {
    const child = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(child);

    const result = writeForgeScaffoldWithStableParent(request);
    child.stderr.emit('data', Buffer.from('worker startup failed'));
    child.emit('exit', 1);

    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'worker startup failed',
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('keeps worker stderr bounded when one chunk exceeds the limit', async () => {
    const child = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(child);

    const result = writeForgeScaffoldWithStableParent(request);
    child.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024, 'x'));
    child.emit('exit', 1);

    await expect(result).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'x'.repeat(16 * 1024),
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
