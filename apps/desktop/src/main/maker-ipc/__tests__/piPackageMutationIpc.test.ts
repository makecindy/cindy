import { describe, expect, it, vi } from 'vitest';

import { createIpcError } from '../../../shared/ipc-errors.js';
import {
  runPiPackageListIpcBoundary,
  runPiPackageMutationIpcBoundary,
} from '../piPackageMutationIpc.js';

describe('Pi package list IPC boundary', () => {
  it('maps backend details to a stable renderer-visible code and message', async () => {
    const log = vi.fn();
    await expect(runPiPackageListIpcBoundary(
      async () => { throw new Error('C:\\private\\pi.exe stderr secret'); },
      'The Pi extension list could not be loaded.',
      log,
    )).rejects.toMatchObject({
      code: 'PI_PACKAGE_LIST_FAILED',
      message: '[PI_PACKAGE_LIST_FAILED] The Pi extension list could not be loaded.',
    });
    expect(log).toHaveBeenCalledOnce();
  });
});

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

  it('selects an actionable safe message from the stable failure category', async () => {
    const privateFailure = new Error('/private/store stale target');
    await expect(runPiPackageMutationIpcBoundary(
      async () => { throw privateFailure; },
      (error) => error === privateFailure ? 'Restart Cindy and refresh extensions.' : 'Try again.',
      vi.fn(),
    )).rejects.toMatchObject({
      code: 'PI_PACKAGE_MUTATION_FAILED',
      message: '[PI_PACKAGE_MUTATION_FAILED] Restart Cindy and refresh extensions.',
    });
  });
});
