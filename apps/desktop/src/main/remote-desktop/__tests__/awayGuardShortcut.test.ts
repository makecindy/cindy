/**
 * 测试价值：真实 installAwayGuardShortcut 入口的注册、热改绑、录制让路和在途去重。
 * 规则依据：本需求要求主动触发且可配置；旧截图测试不覆盖离开入口的生命周期。
 * 最小失败输入：录制已注册的组合，或改绑后再按旧键；tier: unit，Electron 内存 fake。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveAppShortcuts, type AppShortcutCombo, type AppShortcutOverrides } from '../../../shared/appShortcuts';
import type { VoiceInputShortcut } from '../../../shared/voiceInputData';
const state = vi.hoisted(() => ({
  combo: { code: 'KeyL', ctrl: true, shift: true, alt: false, meta: false },
  overrides: {} as AppShortcutOverrides,
  voice: null as VoiceInputShortcut | null,
  voiceChanged: () => {},
  recording: false,
  changed: () => {},
  recordingChanged: () => {},
  callback: () => {},
  register: vi.fn(),
  unregister: vi.fn(),
  report: vi.fn(),
}));
vi.mock('electron', () => ({ globalShortcut: {
  register: (key: string, cb: () => void) => { state.callback = cb; return state.register(key); },
  unregister: state.unregister,
} }));
vi.mock('../../app-shortcuts', () => ({
  getAppShortcutStore: () => ({
    getEffectiveMap: (yieldTo: AppShortcutCombo[] = []) => getEffectiveAppShortcuts(state.overrides, 'darwin', yieldTo),
    subscribe: (cb: () => void) => { state.changed = cb; return () => {}; },
  }),
  isAppShortcutRecordingActive: () => state.recording,
  subscribeAppShortcutRecording: (cb: () => void) => { state.recordingChanged = cb; return () => {}; },
  setGlobalShortcutRegistrationFailures: state.report,
}));
vi.mock('../../voice-input/VoiceInputDataStore', () => ({
  voiceInputDataStore: {
    getSettings: () => ({ shortcut: state.voice }),
    subscribeShortcut: (cb: () => void) => { state.voiceChanged = cb; return () => { state.voiceChanged = () => {}; }; },
  },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { installAwayGuardShortcut } from '../awayGuardShortcut';
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.clearAllMocks();
  state.overrides = {};
  state.voice = null;
  state.voiceChanged = () => {};
  state.recording = false;
  state.combo = { code: 'KeyL', ctrl: true, shift: true, alt: false, meta: false };
});
describe('away shortcut', () => {
  it('activates through the registered shortcut and ignores repeats while starting', async () => {
    state.register.mockReturnValue(true);
    let finish = () => {};
    const activate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    dispose = installAwayGuardShortcut(activate);
    state.callback();
    state.callback();
    expect(activate).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => { state.callback(); expect(activate).toHaveBeenCalledTimes(2); });
    finish();
  });
  it('rebinds after releasing keys, gives recording the key, and restores registration afterwards', async () => {
    state.register.mockReturnValue(true);
    dispose = installAwayGuardShortcut(async () => {});
    const oldKey = state.register.mock.calls[0][0];
    state.combo = { ...state.combo, code: 'KeyK' };
    state.overrides = { 'away-guard': state.combo };
    state.changed();
    await Promise.resolve();
    expect(state.unregister).toHaveBeenCalledWith(oldKey);
    const newKey = state.register.mock.lastCall?.[0];
    expect(newKey).not.toBe(oldKey);
    state.recording = true;
    state.recordingChanged();
    expect(state.unregister).toHaveBeenCalledWith(newKey);
    state.recording = false;
    state.recordingChanged();
    await Promise.resolve();
    expect(state.register).toHaveBeenCalledTimes(3);
    dispose();
    expect(state.unregister).toHaveBeenLastCalledWith(newKey);
  });
  it('reports registration failure with its own source and clears it after success', async () => {
    state.register.mockReturnValue(false);
    dispose = installAwayGuardShortcut(async () => {});
    expect(state.report).toHaveBeenLastCalledWith(['away-guard'], 'away-guard');
    state.register.mockReturnValue(true);
    state.changed();
    await Promise.resolve();
    expect(state.report).toHaveBeenLastCalledWith([], 'away-guard');
  });
  // PR #10218：renderer 已让位而 main 抢占语音默认键，升级后语音会变成遮屏。
  it('yields to the persisted voice combo before registering and updates when it changes', async () => {
    state.register.mockReturnValue(true);
    state.voice = { trigger: 'keyboard', code: 'KeyL', key: 'l', modifiers: { ...state.combo, fn: false } };
    dispose = installAwayGuardShortcut(async () => {});
    await Promise.resolve();
    expect(state.register).not.toHaveBeenCalled();
    state.voice = null;
    state.voiceChanged();
    await Promise.resolve();
    expect(state.register).toHaveBeenCalledTimes(1);
    const key = state.register.mock.lastCall?.[0];
    state.voice = { trigger: 'keyboard', code: 'KeyL', key: 'l', modifiers: { ...state.combo, fn: false } };
    state.voiceChanged();
    await Promise.resolve();
    expect(state.unregister).toHaveBeenCalledWith(key);
    expect(state.register).toHaveBeenCalledTimes(1);
  });

  // PR #10218：按真实启动顺序先通知离开注册方，截图随后才释放旧的 ⌃⇧L。
  it('reclaims the default after a later screenshot listener releases it', async () => {
    state.overrides = { 'region-screenshot': state.combo };
    state.register.mockImplementation(() => !screenshotOwnsKey);
    let screenshotOwnsKey = true;
    dispose = installAwayGuardShortcut(async () => {});
    await Promise.resolve();
    expect(state.register).not.toHaveBeenCalled();
    state.overrides = {};
    state.changed();
    // 第二个同步订阅者处理同一次 restore-defaults；之前会先注册失败而永不重试。
    screenshotOwnsKey = false;
    await Promise.resolve();
    expect(state.register).toHaveBeenCalledTimes(1);
    expect(state.report).toHaveBeenLastCalledWith([], 'away-guard');
    state.callback();
  });

  it.each(['recording', 'dispose'] as const)('cancels a queued rebind on %s', async (cancel) => {
    state.register.mockReturnValue(true);
    dispose = installAwayGuardShortcut(async () => {});
    state.overrides = { 'away-guard': { ...state.combo, code: 'KeyK' } };
    state.changed();
    if (cancel === 'recording') {
      state.recording = true;
      state.recordingChanged();
    } else dispose();
    await Promise.resolve();
    expect(state.register).toHaveBeenCalledTimes(1);
  });

});
