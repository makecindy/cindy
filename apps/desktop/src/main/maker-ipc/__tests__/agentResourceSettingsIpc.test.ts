import { describe, expect, it, vi } from 'vitest';

import type { AgentResourceSettings } from '../../maker-host/agent-resource-settings-store';
import { createAgentResourceSettingsIpc } from '../agent-resource-settings-ipc';

const DEFAULTS: AgentResourceSettings = {
  maxConcurrentCommands: 0,
  processPriority: 'normal',
  capToolchainThreads: false,
};

function makeIpc(overrides?: {
  assertTrustedSender?: (event: unknown) => void;
  writeThrows?: boolean;
  resetThrows?: boolean;
}) {
  let value: AgentResourceSettings = { ...DEFAULTS };
  const customized = new Set<string>();
  const assertTrustedSender = vi.fn(overrides?.assertTrustedSender ?? (() => {}));
  const write = vi.fn(
    (key: keyof AgentResourceSettings, v: AgentResourceSettings[keyof AgentResourceSettings]) => {
      if (overrides?.writeThrows) throw new Error('EACCES: /internal/abs/path readonly');
      value = { ...value, [key]: v };
      customized.add(key);
    },
  );
  const reset = vi.fn(() => {
    if (overrides?.resetThrows) throw new Error('EROFS: /internal/abs/path readonly');
    value = { ...DEFAULTS };
    customized.clear();
    return value;
  });
  const ipc = createAgentResourceSettingsIpc({
    assertTrustedSender,
    readState: () => ({
      value: { ...value },
      isCustomized: customized.size > 0,
      defaults: { ...DEFAULTS },
      customizedKeys: [...customized],
    }),
    write,
    reset,
  });
  return { ipc, assertTrustedSender, write, reset };
}

const EVENT = { senderFrame: 'fake' };

describe('agent resource settings IPC business body', () => {
  it('rejects untrusted senders on all three routes before any side effect', () => {
    const untrusted = () => {
      throw new Error('untrusted sender');
    };
    const { ipc, write, reset } = makeIpc({ assertTrustedSender: untrusted });
    expect(() => ipc.get(EVENT)).toThrow('untrusted sender');
    expect(() => ipc.set(EVENT, { key: 'maxConcurrentCommands', value: 2 })).toThrow(
      'untrusted sender',
    );
    expect(() => ipc.reset(EVENT)).toThrow('untrusted sender');
    expect(write).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('returns the wire shape with defaults and customization state', () => {
    const { ipc } = makeIpc();
    expect(ipc.get(EVENT)).toEqual({
      ...DEFAULTS,
      isCustomized: false,
      customizedKeys: [],
      defaults: DEFAULTS,
    });
    const next = ipc.set(EVENT, { key: 'processPriority', value: 'low' });
    expect(next.processPriority).toBe('low');
    expect(next.isCustomized).toBe(true);
    expect(next.customizedKeys).toEqual(['processPriority']);
  });

  it.each([
    [{ key: 'nope', value: 1 }, 'unknown key'],
    [{}, 'key required'],
    [{ key: 'maxConcurrentCommands', value: '5' }, 'must be an integer'],
    [{ key: 'maxConcurrentCommands', value: 3.5 }, 'must be an integer'],
    [{ key: 'maxConcurrentCommands', value: -1 }, 'must be >= 0'],
    [{ key: 'maxConcurrentCommands', value: 65 }, 'must be <= 64'],
    [{ key: 'processPriority', value: 'turbo' }, 'must be one of'],
    [{ key: 'processPriority', value: 19 }, 'must be one of'],
    [{ key: 'capToolchainThreads', value: 1 }, 'must be a boolean'],
    [{ key: 'capToolchainThreads', value: 'yes' }, 'must be a boolean'],
  ])('hard-rejects invalid payload %j with INVALID_PARAMS', (body, messagePart) => {
    const { ipc, write } = makeIpc();
    expect(() => ipc.set(EVENT, body)).toThrow(`[INVALID_PARAMS]`);
    expect(() => ipc.set(EVENT, body)).toThrow(messagePart);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['maxConcurrentCommands', 0],
    ['maxConcurrentCommands', 64],
    ['processPriority', 'lowest'],
    ['capToolchainThreads', true],
  ] as const)('accepts boundary/valid value %s=%j', (key, value) => {
    const { ipc } = makeIpc();
    const next = ipc.set(EVENT, { key, value });
    expect(next[key]).toBe(value);
  });

  it('converts store write failures to [INTERNAL] without leaking fs details', () => {
    const { ipc } = makeIpc({ writeThrows: true });
    let caught: Error | null = null;
    try {
      ipc.set(EVENT, { key: 'maxConcurrentCommands', value: 2 });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('[INTERNAL]');
    // 原始 fs 异常里的内部绝对路径不得透出
    expect(caught?.message).not.toContain('/internal/abs/path');
  });

  it('converts store reset failures to [INTERNAL] without leaking fs details', () => {
    const { ipc } = makeIpc({ resetThrows: true });
    let caught: Error | null = null;
    try {
      ipc.reset(EVENT);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('[INTERNAL]');
    expect(caught?.message).not.toContain('/internal/abs/path');
  });
});
