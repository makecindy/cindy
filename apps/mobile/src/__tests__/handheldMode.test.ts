// Handheld mode: persisted preferences and the voice-key hand-off between
// pages. The hand-off matters because holding the key on the home screen opens
// the new-task page, which must take over the same hold and its release.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ value: null as string | null, failWrite: false }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'CindyHandheld' ? { available: true } : null),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => storage.value),
    setItem: vi.fn(async (_key: string, value: string) => {
      if (storage.failWrite) throw new Error('disk full');
      storage.value = value;
    }),
    removeItem: vi.fn(async () => { storage.value = null; }),
  },
}));

import {
  DEFAULT_HANDHELD_SETTINGS,
  dispatchHandheldVoiceKey,
  getHandheldSettingsSnapshot,
  handheldKeyLabel,
  hydrateHandheldSettings,
  parseHandheldSettings,
  registerHandheldVoiceKeyHandler,
  resetHandheldSettings,
  resetHandheldVoiceKeyForTests,
  updateHandheldSettings,
} from '@/handheld/handheldMode';

function recorder() {
  const calls: string[] = [];
  return { calls, handler: { start: () => calls.push('start'), end: () => calls.push('end') } };
}

beforeEach(() => {
  storage.value = null;
  storage.failWrite = false;
  resetHandheldVoiceKeyForTests();
});

describe('handheld settings', () => {
  it('defaults to off with X as the voice key and the second screen preferred', () => {
    expect(parseHandheldSettings(null)).toEqual({ enabled: false, voiceKeyCode: 99, useSecondaryDisplay: true });
  });

  it('falls back to defaults for corrupt or partial values', () => {
    expect(parseHandheldSettings('{oops')).toEqual(DEFAULT_HANDHELD_SETTINGS);
    expect(parseHandheldSettings(JSON.stringify({ enabled: true, voiceKeyCode: -3 }))).toEqual({
      enabled: true,
      voiceKeyCode: 99,
      useSecondaryDisplay: true,
    });
    expect(parseHandheldSettings(JSON.stringify({ voiceKeyCode: 188, voiceKeyName: '1', useSecondaryDisplay: false }))).toEqual({
      enabled: false,
      voiceKeyCode: 188,
      voiceKeyName: '1',
      useSecondaryDisplay: false,
    });
  });

  it('hydrates once and persists updates; picking a listed key drops a captured key name', async () => {
    storage.value = JSON.stringify({ enabled: true, voiceKeyCode: 188, voiceKeyName: '1' });
    await hydrateHandheldSettings();
    expect(getHandheldSettingsSnapshot()).toEqual({
      hydrated: true,
      settings: { enabled: true, voiceKeyCode: 188, voiceKeyName: '1', useSecondaryDisplay: true },
    });
    await updateHandheldSettings({ voiceKeyCode: 100 });
    expect(JSON.parse(storage.value!)).toEqual({ enabled: true, voiceKeyCode: 100 });
  });

  it('persists only explicit choices and deletes them when restoring defaults', async () => {
    await hydrateHandheldSettings();
    await updateHandheldSettings({ enabled: true });
    expect(JSON.parse(storage.value!)).toEqual({ enabled: true });
    await resetHandheldSettings();
    expect(storage.value).toBeNull();
    expect(getHandheldSettingsSnapshot().settings).toEqual(DEFAULT_HANDHELD_SETTINGS);
  });

  it('keeps the new choice in memory when saving fails', async () => {
    storage.failWrite = true;
    await expect(updateHandheldSettings({ enabled: true })).rejects.toThrow('disk full');
    expect(getHandheldSettingsSnapshot().settings.enabled).toBe(true);
  });

  it('labels gamepad keys the way handhelds print them', () => {
    expect(handheldKeyLabel(99)).toBe('X');
    expect(handheldKeyLabel(106)).toBe('L3');
    expect(handheldKeyLabel(188, 'KEYCODE_BUTTON_1')).toBe('1');
  });
});

describe('handheld voice key dispatch', () => {
  it('sends start and end to the most recently focused page only', () => {
    const home = recorder();
    const session = recorder();
    registerHandheldVoiceKeyHandler(home.handler);
    const unregister = registerHandheldVoiceKeyHandler(session.handler);
    dispatchHandheldVoiceKey('start');
    dispatchHandheldVoiceKey('end');
    expect(session.calls).toEqual(['start', 'end']);
    expect(home.calls).toEqual([]);
    unregister();
    dispatchHandheldVoiceKey('start');
    dispatchHandheldVoiceKey('cancel');
    expect(home.calls).toEqual(['start', 'end']);
  });

  it('hands a hold that is still down to the page that opens next', () => {
    const home = recorder();
    const newTask = recorder();
    const unregisterHome = registerHandheldVoiceKeyHandler(home.handler);
    dispatchHandheldVoiceKey('start');
    unregisterHome();
    registerHandheldVoiceKeyHandler(newTask.handler);
    dispatchHandheldVoiceKey('end');
    expect(home.calls).toEqual(['start', 'end']);
    expect(newTask.calls).toEqual(['start', 'end']);
  });

  it('stops recording when its page blurs even if no new voice page takes over', () => {
    const page = recorder();
    const unregister = registerHandheldVoiceKeyHandler(page.handler);
    dispatchHandheldVoiceKey('start');
    unregister();
    expect(page.calls).toEqual(['start', 'end']);
    dispatchHandheldVoiceKey('end');
    expect(page.calls).toEqual(['start', 'end']);
  });

  it('ends the previous recording if the next page focuses before the old page blurs', () => {
    const first = recorder();
    const next = recorder();
    const unregister = registerHandheldVoiceKeyHandler(first.handler);
    dispatchHandheldVoiceKey('start');
    registerHandheldVoiceKeyHandler(next.handler);
    unregister();
    dispatchHandheldVoiceKey('end');
    expect(first.calls).toEqual(['start', 'end']);
    expect(next.calls).toEqual(['start', 'end']);
  });

  it('ignores short taps and pages that open after release', () => {
    const page = recorder();
    dispatchHandheldVoiceKey('start');
    dispatchHandheldVoiceKey('end');
    dispatchHandheldVoiceKey('tap');
    registerHandheldVoiceKeyHandler(page.handler);
    expect(page.calls).toEqual([]);
  });
});
