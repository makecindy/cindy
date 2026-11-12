import { describe, expect, it, vi } from 'vitest';

import type { CodexMicroGuardState } from '../../../shared/codexMicroGuard.js';
import { createCodexMicroGuardIpc } from '../codexMicroGuardIpc.js';

const EVENT = { senderFrame: 'trusted' };
const DISABLED: CodexMicroGuardState = {
  supported: true,
  enabled: false,
  status: 'disabled',
};

describe('Codex Micro guard IPC', () => {
  it('checks sender trust before every operation', async () => {
    const assertTrustedSender = vi.fn(() => {
      throw new Error('untrusted');
    });
    const getState = vi.fn(async () => DISABLED);
    const setEnabled = vi.fn(async () => DISABLED);
    const recover = vi.fn(async () => DISABLED);
    const ipc = createCodexMicroGuardIpc({
      assertTrustedSender,
      getState,
      setEnabled,
      recover,
    });

    await expect(ipc.get(EVENT)).rejects.toThrow('untrusted');
    await expect(ipc.setEnabled(EVENT, true)).rejects.toThrow('untrusted');
    await expect(ipc.recover(EVENT)).rejects.toThrow('untrusted');
    expect(getState).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('accepts only a boolean setting and returns the service state', async () => {
    const enabled: CodexMicroGuardState = {
      supported: true,
      enabled: true,
      status: 'protecting',
    };
    const setEnabled = vi.fn(async () => enabled);
    const ipc = createCodexMicroGuardIpc({
      assertTrustedSender: vi.fn(),
      getState: vi.fn(async () => DISABLED),
      setEnabled,
      recover: vi.fn(async () => DISABLED),
    });

    await expect(ipc.setEnabled(EVENT, 'yes')).rejects.toThrow('[INVALID_PARAMS]');
    await expect(ipc.setEnabled(EVENT, true)).resolves.toEqual(enabled);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it('maps service failures to INTERNAL without leaking details', async () => {
    const ipc = createCodexMicroGuardIpc({
      assertTrustedSender: vi.fn(),
      getState: vi.fn(async () => {
        throw new Error('private /Users/example/path');
      }),
      setEnabled: vi.fn(async () => {
        throw new Error('private /Users/example/path');
      }),
      recover: vi.fn(async () => {
        throw new Error('private /Users/example/path');
      }),
    });

    await expect(ipc.get(EVENT)).rejects.toThrow('[INTERNAL] Codex Micro guard state unavailable');
    await expect(ipc.setEnabled(EVENT, true)).rejects.toThrow(
      '[INTERNAL] Codex Micro guard update failed',
    );
    await expect(ipc.recover(EVENT)).rejects.toThrow(
      '[INTERNAL] Codex Micro guard recovery failed',
    );
  });
});
