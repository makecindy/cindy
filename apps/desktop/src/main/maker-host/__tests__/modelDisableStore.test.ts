/**
 * Unit regression for provider suspension notifications: persisted disable and
 * reset must fence/resume account services. Existing provider-handler tests use
 * injected store functions and do not exercise these public store operations.
 * An in-memory storage adapter keeps the fixture separate from handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  value: { disabledProviders: {}, disabledModels: {} } as {
    disabledProviders: Record<string, true>;
    disabledModels: Record<string, true>;
  },
  write: vi.fn(),
}));
vi.mock('../override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: vi.fn(),
    read: () => mocks.value,
    writePatch: mocks.write,
  }),
  portableOverrideSettings: () => ({ readCustomized: () => ({}), applyPatch: async () => false }),
}));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => 'unused' }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import {
  clearProviderDisableOverrides,
  onProviderDisableChange,
  readModelDisableOverrides,
  setModelsDisabled,
  setProviderDisabled,
} from '../model-disable-store.js';

const unsubscribers: Array<() => void> = [];
function observe(listener: (id: string) => void): () => void {
  const off = onProviderDisableChange(listener);
  unsubscribers.push(off);
  return off;
}

beforeEach(() => {
  mocks.value = { disabledProviders: {}, disabledModels: {} };
  mocks.write.mockReset().mockImplementation(patch => { mocks.value = { ...mocks.value, ...patch }; });
});
afterEach(() => { for (const off of unsubscribers.splice(0)) off(); });

describe('provider disable state notifications', () => {
  it('publishes the persisted state on disable/enable and ignores unchanged writes', () => {
    const states: boolean[] = [];
    observe(id => { states.push(readModelDisableOverrides().disabledProviders?.[id] === true); });

    setProviderDisabled('xd', true);
    setProviderDisabled('xd', true);
    setProviderDisabled('xd', false);

    expect(states).toEqual([true, false]);
    expect(readModelDisableOverrides().disabledProviders).toEqual({});
  });

  it('publishes re-enable after reset while model-only changes do not change provider access', () => {
    setProviderDisabled('xd', true);
    const observed: string[] = [];
    observe(id => {
      expect(readModelDisableOverrides().disabledProviders?.[id]).toBeUndefined();
      observed.push(id);
    });

    setModelsDisabled('xd', ['example-model'], true);
    expect(observed).toEqual([]);
    clearProviderDisableOverrides('xd');

    expect(observed).toEqual(['xd']);
    expect(readModelDisableOverrides()).toEqual({ disabledProviders: {}, disabledModels: {} });
  });

  it('does not publish a rejected persistence operation', () => {
    const listener = vi.fn();
    observe(listener);
    mocks.write.mockImplementation(() => { throw new Error('storage unavailable'); });

    expect(() => setProviderDisabled('xd', true)).toThrow('storage unavailable');
    expect(listener).not.toHaveBeenCalled();
    expect(readModelDisableOverrides().disabledProviders).toEqual({});
  });

  it('isolates observer failures and lets observers unsubscribe', () => {
    observe(() => { throw new Error('observer unavailable'); });
    const listener = vi.fn();
    const off = observe(listener);

    expect(() => setProviderDisabled('xd', true)).not.toThrow();
    expect(readModelDisableOverrides().disabledProviders).toEqual({ xd: true });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    setProviderDisabled('xd', false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
