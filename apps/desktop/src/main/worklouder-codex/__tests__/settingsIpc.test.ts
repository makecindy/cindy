import { describe, expect, it, vi } from 'vitest';

import type {
  WorkLouderCodexSettings,
  WorkLouderCodexState,
} from '../../../shared/workLouderCodex.js';
import { createWorkLouderCodexSettingsIpc } from '../settingsIpc.js';

const DEFAULT_SETTINGS: WorkLouderCodexSettings = {
  lightingBrightness: 100,
  lightingAutoDim: '3-minutes',
  singleTapAgentKeys: true,
};

const EVENT = { senderFrame: 'fake' };

function makeIpc(options?: {
  assertTrustedSender?: (event: unknown) => void;
  writeThrows?: boolean;
}) {
  let settings = { ...DEFAULT_SETTINGS };
  const assertTrustedSender = vi.fn(options?.assertTrustedSender ?? (() => undefined));
  const writeSettings = vi.fn((patch: Partial<WorkLouderCodexSettings>) => {
    if (options?.writeThrows) throw new Error('EACCES: /internal/private/path readonly');
    settings = { ...settings, ...patch };
    return { ...settings };
  });
  const applySettings = vi.fn((next: WorkLouderCodexSettings) => {
    settings = { ...next };
  });
  const getState = vi.fn((): WorkLouderCodexState => ({
    connectionStatus: 'connected',
    settings: { ...settings },
    agentSource: 'recent',
    agentSlotCount: 6,
  }));
  const ipc = createWorkLouderCodexSettingsIpc({
    assertTrustedSender,
    getState,
    writeSettings,
    applySettings,
  });
  return { ipc, assertTrustedSender, getState, writeSettings, applySettings };
}

describe('Work Louder Codex settings IPC business body', () => {
  it('rejects an untrusted sender before reading or writing device state', () => {
    const untrusted = () => {
      throw new Error('untrusted sender');
    };
    const { ipc, getState, writeSettings, applySettings } = makeIpc({
      assertTrustedSender: untrusted,
    });

    expect(() => ipc.get(EVENT)).toThrow('untrusted sender');
    expect(() => ipc.set(EVENT, { lightingBrightness: 50 })).toThrow('untrusted sender');
    expect(getState).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'settings patch required'],
    [[], 'settings patch required'],
    [{}, 'cannot be empty'],
    [{ unknown: true }, 'unknown Work Louder Codex setting'],
    [{ lightingBrightness: '50' }, 'must be an integer'],
    [{ lightingBrightness: 49.5 }, 'must be an integer'],
    [{ lightingBrightness: -1 }, 'must be an integer'],
    [{ lightingBrightness: 101 }, 'must be an integer'],
    [{ lightingAutoDim: 'sometimes' }, 'lightingAutoDim is invalid'],
    [{ singleTapAgentKeys: 1 }, 'must be a boolean'],
  ])('rejects invalid payload %j with INVALID_PARAMS', (value, messagePart) => {
    const { ipc, writeSettings, applySettings } = makeIpc();

    expect(() => ipc.set(EVENT, value)).toThrow('[INVALID_PARAMS]');
    expect(() => ipc.set(EVENT, value)).toThrow(messagePart);
    expect(writeSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
  });

  it('persists, applies, and returns a valid settings patch', () => {
    const { ipc, writeSettings, applySettings } = makeIpc();
    const patch = {
      lightingBrightness: 40,
      lightingAutoDim: 'off' as const,
      singleTapAgentKeys: false,
    };

    const state = ipc.set(EVENT, patch);

    expect(writeSettings).toHaveBeenCalledWith(patch);
    expect(applySettings).toHaveBeenCalledWith({
      lightingBrightness: 40,
      lightingAutoDim: 'off',
      singleTapAgentKeys: false,
    });
    expect(state.settings).toEqual({
      lightingBrightness: 40,
      lightingAutoDim: 'off',
      singleTapAgentKeys: false,
    });
  });

  it('converts persistence failures to INTERNAL without leaking file paths', () => {
    const { ipc, applySettings } = makeIpc({ writeThrows: true });
    let caught: Error | null = null;
    try {
      ipc.set(EVENT, { lightingBrightness: 20 });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain('[INTERNAL]');
    expect(caught?.message).not.toContain('/internal/private/path');
    expect(applySettings).not.toHaveBeenCalled();
  });
});
