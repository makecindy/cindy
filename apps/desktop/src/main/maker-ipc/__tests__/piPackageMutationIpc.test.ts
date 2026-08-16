import { describe, expect, it, vi } from 'vitest';

import { createIpcError } from '../../../shared/ipc-errors.js';
import { runPiPackageMutationIpcBoundary } from '../piPackageMutationIpc.js';

describe('Pi package mutation IPC boundary', () => {
  it('preserves explicit user cancellation', async () => {
    const cancellation = createIpcError('MUTATION_CANCELLED', 'cancelled');
    const log = vi.fn();
    await expect(runPiPackageMutationIpcBoundary(
      async () => { throw cancellation; },
      'safe failure',
      log,
    )).rejects.toBe(cancellation);
    expect(log).not.toHaveBeenCalled();
  });

  it('maps backend details to a stable safe code and message', async () => {
    const log = vi.fn();
    await expect(runPiPackageMutationIpcBoundary(
      async () => { throw new Error('/private/store npm stderr secret'); },
      'The Pi extension operation failed.',
      log,
    )).rejects.toMatchObject({
      code: 'PI_PACKAGE_MUTATION_FAILED',
      message: '[PI_PACKAGE_MUTATION_FAILED] The Pi extension operation failed.',
    });
    expect(log).toHaveBeenCalledOnce();
  });
});
