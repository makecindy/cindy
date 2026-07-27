import { describe, expect, it, vi } from 'vitest';

import { createLegacyGhostRecoveryIpcHandlers } from '../legacyGhostRecoveryIpc.js';

describe('legacy Ghost recovery IPC boundary', () => {
  it('authenticates the sender and returns only the coarse status projection', () => {
    const event = { sender: 'trusted' };
    const assertTrusted = vi.fn();
    const getStatus = vi.fn(() => ({
      state: 'deferred' as const,
      legacyPluginCount: 2,
      canRetry: true,
    }));
    const handlers = createLegacyGhostRecoveryIpcHandlers({
      assertTrusted,
      invalid: (message) => {
        throw new Error(message);
      },
      failure: (error) => {
        throw error;
      },
      getStatus,
      retry: vi.fn(),
    });

    expect(handlers.status(event)).toEqual({
      state: 'deferred',
      legacyPluginCount: 2,
      canRetry: true,
    });
    expect(assertTrusted).toHaveBeenCalledWith(event);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected renderer payload before reading or moving data', async () => {
    const getStatus = vi.fn();
    const retry = vi.fn();
    const handlers = createLegacyGhostRecoveryIpcHandlers({
      assertTrusted: vi.fn(),
      invalid: (message) => {
        throw new Error(message);
      },
      failure: (error) => {
        throw error;
      },
      getStatus,
      retry,
    });

    expect(() => handlers.status({}, 'owner-id')).toThrow(/does not accept renderer payload/);
    await expect(handlers.retry({}, { path: 'legacy' })).rejects.toThrow(
      /does not accept renderer payload/,
    );
    expect(getStatus).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not execute a request rejected by the sender guard', async () => {
    const getStatus = vi.fn();
    const retry = vi.fn();
    const handlers = createLegacyGhostRecoveryIpcHandlers({
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
      invalid: (message) => {
        throw new Error(message);
      },
      failure: (error) => {
        throw error;
      },
      getStatus,
      retry,
    });

    expect(() => handlers.status({})).toThrow(/untrusted sender/);
    await expect(handlers.retry({})).rejects.toThrow(/untrusted sender/);
    expect(getStatus).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('normalizes retry failures before they cross the IPC boundary', async () => {
    const rawError = new Error('rename C:\\Users\\secret\\legacy C:\\Users\\secret\\owner');
    const failure = vi.fn((error: unknown) => {
      expect(error).toBe(rawError);
      throw new Error('Legacy Plugin recovery failed.');
    });
    const handlers = createLegacyGhostRecoveryIpcHandlers({
      assertTrusted: vi.fn(),
      invalid: (message) => {
        throw new Error(message);
      },
      failure,
      getStatus: vi.fn(),
      retry: vi.fn(async () => {
        throw rawError;
      }),
    });

    await expect(handlers.retry({})).rejects.toThrow('Legacy Plugin recovery failed.');
    await expect(handlers.retry({})).rejects.not.toThrow('secret');
    expect(failure).toHaveBeenCalledTimes(2);
  });
});
