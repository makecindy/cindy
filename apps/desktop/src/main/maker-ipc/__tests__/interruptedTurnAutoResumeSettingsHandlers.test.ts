import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createInterruptedTurnAutoResumeSettingsHandlers } from '../interruptedTurnAutoResumeSettingsHandlers';

function createHarness() {
  const readState = vi.fn(() => ({
    value: { enabled: true },
    defaults: { enabled: true },
    isCustomized: false,
  }));
  const writeEnabled = vi.fn(async () => undefined);
  const reset = vi.fn(async () => undefined);
  const cancelWaiting = vi.fn();
  const log = { error: vi.fn() };
  const handlers = createInterruptedTurnAutoResumeSettingsHandlers({
    readState,
    writeEnabled,
    reset,
    cancelWaiting,
    log,
  });
  return { handlers, readState, writeEnabled, reset, cancelWaiting, log };
}

describe('interrupted turn auto-resume settings IPC handlers', () => {
  it('validates input before persistence and cancels waiting work only after disabling succeeds', async () => {
    const { handlers, readState, writeEnabled, cancelWaiting, log } = createHarness();

    await expect(handlers.set('false')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(writeEnabled).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();

    readState.mockReturnValue({
      value: { enabled: false },
      defaults: { enabled: true },
      isCustomized: true,
    });
    await expect(handlers.set(false)).resolves.toEqual({
      enabled: false,
      defaultEnabled: true,
      isCustomized: true,
      effective: 'immediate',
    });
    expect(writeEnabled).toHaveBeenCalledWith(false);
    expect(cancelWaiting).toHaveBeenCalledOnce();
  });

  it('logs write details in Main but returns a stable IPC error without the userData path', async () => {
    const { handlers, writeEnabled, cancelWaiting, log } = createHarness();
    const privatePath = path.join(os.tmpdir(), 'private-user-data', 'settings.json');
    const originalMessage = `EACCES: permission denied, rename '${privatePath}'`;
    writeEnabled.mockRejectedValueOnce(new Error(originalMessage));

    const error = await handlers.set(false).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] interrupted turn auto-resume settings write failed',
    });
    expect((error as Error).message).not.toContain(privatePath);
    expect(log.error).toHaveBeenCalledWith(
      'interrupted turn auto-resume settings operation failed',
      { action: 'write', error: originalMessage },
    );
    expect(cancelWaiting).not.toHaveBeenCalled();
  });

  it('applies the same error boundary to reset failures', async () => {
    const { handlers, reset, log } = createHarness();
    const privatePath = path.join(os.tmpdir(), 'private-user-data', 'settings.json');
    const originalMessage = `EPERM: operation not permitted, unlink '${privatePath}'`;
    reset.mockRejectedValueOnce(new Error(originalMessage));

    const error = await handlers.reset().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] interrupted turn auto-resume settings reset failed',
    });
    expect((error as Error).message).not.toContain(privatePath);
    expect(log.error).toHaveBeenCalledWith(
      'interrupted turn auto-resume settings operation failed',
      { action: 'reset', error: originalMessage },
    );
  });

  it('sanitizes an unexpected read failure too', () => {
    const { handlers, readState, log } = createHarness();
    const privatePath = path.join(os.tmpdir(), 'private-user-data', 'settings.json');
    const originalMessage = `EIO: failed to read '${privatePath}'`;
    readState.mockImplementationOnce(() => {
      throw new Error(originalMessage);
    });

    expect(() => handlers.get()).toThrowError(
      '[INTERNAL] interrupted turn auto-resume settings read failed',
    );
    expect(log.error).toHaveBeenCalledWith(
      'interrupted turn auto-resume settings operation failed',
      { action: 'read', error: originalMessage },
    );
  });
});
