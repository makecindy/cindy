/**
 * 测试价值：真实 installAwayGuardShortcut 入口的注册、热改绑、录制让路和在途去重。
 * 规则依据：本需求要求主动触发且可配置；旧截图测试不覆盖离开入口的生命周期。
 * 最小失败输入：录制已注册的组合，或改绑后再按旧键；tier: unit，Electron 内存 fake。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  combo: { code: 'KeyL', ctrl: true, shift: true, alt: false, meta: false },
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
    getEffectiveMap: () => new Map([['away-guard', state.combo ? [state.combo] : []]]),
    subscribe: (cb: () => void) => { state.changed = cb; return () => {}; },
  }),
  isAppShortcutRecordingActive: () => state.recording,
  subscribeAppShortcutRecording: (cb: () => void) => { state.recordingChanged = cb; return () => {}; },
  setGlobalShortcutRegistrationFailures: state.report,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { installAwayGuardShortcut } from '../awayGuardShortcut';
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.clearAllMocks();
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
  it('rebinds immediately, gives recording the key, and restores registration afterwards', () => {
    state.register.mockReturnValue(true);
    dispose = installAwayGuardShortcut(async () => {});
    const oldKey = state.register.mock.calls[0][0];
    state.combo = { ...state.combo, code: 'KeyK' };
    state.changed();
    expect(state.unregister).toHaveBeenCalledWith(oldKey);
    const newKey = state.register.mock.lastCall?.[0];
    expect(newKey).not.toBe(oldKey);
    state.recording = true;
    state.recordingChanged();
    expect(state.unregister).toHaveBeenCalledWith(newKey);
    state.recording = false;
    state.recordingChanged();
    expect(state.register).toHaveBeenCalledTimes(3);
    dispose();
    expect(state.unregister).toHaveBeenLastCalledWith(newKey);
  });
  it('reports registration failure with its own source and clears it after success', () => {
    state.register.mockReturnValue(false);
    dispose = installAwayGuardShortcut(async () => {});
    expect(state.report).toHaveBeenLastCalledWith(['away-guard'], 'away-guard');
    state.register.mockReturnValue(true);
    state.changed();
    expect(state.report).toHaveBeenLastCalledWith([], 'away-guard');
  });
});
