// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import settings from '@/i18n/locales/zh-CN/settings.json';

const h = vi.hoisted(() => ({
  record: vi.fn(), enroll: vi.fn(), scroll: vi.fn(), platform: 'ios',
  frames: new Map<number, FrameRequestCallback>(), nextFrame: 0,
  passageY: 180, passageHeight: 100,
  onScroll: null as null | ((event: any) => void),
  snapshot: { supported: true, hydrated: true, enabled: true, enrolled: false,
    strictness: 'standard', strictnessCustomized: false, modelState: 'ready', downloadedBytes: 0, totalBytes: 0 },
}));
vi.mock('react-native', async () => {
  const { createElement: el, useImperativeHandle, useEffect } = await import('react');
  return {
    Alert: { alert: vi.fn() }, Platform: { get OS() { return h.platform; } }, StyleSheet: { create: (styles: unknown) => styles },
    View: ({ ref, children, testID, onLayout }: any) => {
      useImperativeHandle(ref, () => ({ measureInWindow: (cb: any) => cb(0, h.passageY, 320, h.passageHeight) }));
      useEffect(() => { onLayout?.(); }, [onLayout]);
      return el('div', { 'data-testid': testID }, children);
    },
    ScrollView: ({ ref, children, onScroll }: any) => {
      h.onScroll = onScroll;
      useImperativeHandle(ref, () => ({ getNativeScrollRef: () => ({ measureInWindow: (cb: any) => cb(0, 0, 360, 640) }), scrollTo: h.scroll }));
      return el('div', {}, children);
    },
    Pressable: ({ children, onPress, disabled, testID }: any) => el('button', { onClick: onPress, disabled, 'data-testid': testID }, children),
  };
});
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaView: (await import('react-native')).View }));
vi.mock('lucide-react-native', () => ({ Check: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 96 }));
vi.mock('@/config/env', () => ({ MOBILE_VISUAL_MOCK_ENABLED: false }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: (fn: any) => fn({}) }));
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: ({ children, testID, style, accessibilityRole }: any) => el('span', { 'data-testid': testID, style, role: accessibilityRole }, children) };
});
vi.mock('@/components/MobilePrimitives', async () => {
  const { createElement: el } = await import('react');
  const Button = ({ label, onPress, disabled, selected, testID, accessibilityLabel }: any) => el('button', {
    onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-selected': selected,
  }, label);
  return { MainWindowActionButton: ({ action }: any) => el(Button, action), MainWindowOptionButton: Button };
});
vi.mock('@/session/SettingsGroupRows', async () => {
  const { createElement: el } = await import('react');
  return {
    useSettingsRowStyles: () => ({}), SettingsGroup: ({ children }: any) => el('section', {}, children),
    SettingsSwitchRow: () => null, InfoRow: () => null,
    ActionInfoRow: ({ onPress, label, testID, disabled }: any) => el('button', { onClick: onPress, disabled, 'data-testid': testID }, label),
  };
});
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScrollInsetProps: {}, simpleScrollScreenSafeAreaEdges: () => [] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' }, t: (key: string, vars: Record<string, any> = {}) => {
  const value = key.replace(/^settings\./, '').split('.').reduce((data: any, part) => data?.[part], settings);
  return typeof value === 'string' ? value.replace(/{{(\w+)}}/g, (_, name) => String(vars[name])) : key;
} }) }));
vi.mock('@/session/mobileSpeakerFilter', () => ({
  getMobileSpeakerFilterSnapshot: () => h.snapshot, subscribeMobileSpeakerFilter: () => () => {},
  hydrateMobileSpeakerFilter: async () => {}, enrollMobileSpeaker: h.enroll,
  setMobileSpeakerFilterEnabled: async () => {}, setMobileSpeakerFilterStrictness: async () => {},
  deleteMobileSpeakerProfile: async () => {}, downloadMobileSpeakerModels: async () => {}, cancelMobileSpeakerModelDownload: () => {},
}));
vi.mock('@/session/mobileSpeakerEnrollmentRecorder', () => ({
  recordMobileSpeakerClip: h.record, MobileSpeakerEnrollmentAbortedError: class extends Error {},
  MobileSpeakerEnrollmentNoAudioError: class extends Error {},
}));

import { VoiceSpeakerFilterScreen } from '../../app/settings/voice-speaker-filter';

let root: Root;
let host: HTMLDivElement;
const prefix = 'settings.voiceSpeakerFilter.';
function node(id: string) { return host.querySelector(`[data-testid="${prefix}${id}"]`)! as HTMLElement; }
async function click(id: string) { await act(async () => { node(id).click(); }); }
async function frame() {
  await act(async () => { const callbacks = [...h.frames.values()]; h.frames.clear(); callbacks.forEach((cb) => cb(0)); });
}
async function recordAll() {
  await click('profile.enroll');
  for (let i = 0; i < 3; i++) await click('enroll.record');
  await frame();
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.record.mockReset().mockImplementation(async () => new ArrayBuffer(20));
  h.enroll.mockReset(); h.scroll.mockReset(); h.frames.clear(); h.platform = 'ios'; h.passageY = 180;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { h.frames.set(++h.nextFrame, cb); return h.nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { h.frames.delete(id); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<VoiceSpeakerFilterScreen />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('speaker enrollment reader', () => {
  it.each(['too_short', 'no_embedding', 'inconsistent'])('recovers %s into the first passage and keeps other recordings', async (reason) => {
    await recordAll();
    expect(node('enroll.passage').textContent).toBe(settings.voiceSpeakerFilter.enroll.passages.p3);
    h.enroll.mockResolvedValueOnce({ ok: false, reason, clipIndex: 0 });
    h.passageY = -200;
    h.onScroll?.({ nativeEvent: { contentOffset: { y: 480 } } });
    await click('enroll.submit'); await frame();
    expect(node('enroll.passage').textContent).toBe(settings.voiceSpeakerFilter.enroll.passages.p1);
    expect(node('enroll.step.0').getAttribute('aria-label')).toContain('待重录');
    expect(node('enroll.step.1').getAttribute('aria-label')).toContain('已录音');
    expect(node('enroll.step.2').getAttribute('aria-label')).toContain('已录音');
    expect(node('enroll.status').textContent).toContain('其他段录音已保留');
    expect(h.scroll).toHaveBeenCalledWith({ y: 168, animated: false });
    const before = h.enroll.mock.calls[0][0];
    await click('enroll.record');
    h.enroll.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await click('enroll.submit');
    const after = h.enroll.mock.calls[1][0];
    expect(after[0]).not.toBe(before[0]); expect(after[1]).toBe(before[1]); expect(after[2]).toBe(before[2]);
  });

  it('keeps the same passage mounted throughout manual stop and recording progress', async () => {
    await recordAll();
    h.enroll.mockResolvedValueOnce({ ok: false, reason: 'too_short', clipIndex: 2 });
    await click('enroll.submit');
    const passage = node('enroll.passage');
    h.record.mockImplementationOnce((options) => new Promise<ArrayBuffer>((resolve) => {
      options.onProgress(0.2);
      options.stopSignal.addEventListener('abort', () => resolve(new ArrayBuffer(32)), { once: true });
    }));
    await click('enroll.record'); await frame();
    expect(node('enroll.record').textContent).toBe('结束录音');
    expect(node('enroll.passage')).toBe(passage);
    expect(passage.textContent).toBe(settings.voiceSpeakerFilter.enroll.passages.p3);
    expect(passage.style.flex).toBe('');
    expect(node('enroll.status').textContent).toContain('还剩 24 秒');
    expect((node('enroll.step.0') as HTMLButtonElement).disabled).toBe(true);
    expect(h.record.mock.lastCall?.[0].durationMs).toBe(30_000);
    await click('enroll.record');
    expect(node('enroll.passage')).toBe(passage);
    expect(node('enroll.step.2').getAttribute('aria-label')).toContain('已录音');
    expect((node('enroll.submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains the retry marker when manually inspecting another passage', async () => {
    await recordAll();
    h.enroll.mockResolvedValueOnce({ ok: false, reason: 'no_embedding', clipIndex: 0 });
    await click('enroll.submit'); await click('enroll.step.1');
    expect(node('enroll.passage').textContent).toBe(settings.voiceSpeakerFilter.enroll.passages.p2);
    expect(node('enroll.step.0').getAttribute('aria-label')).toContain('待重录');
    await click('enroll.step.0');
    expect(node('enroll.status').textContent).toContain('没能识别出声纹');
  });

  it('does not move an already visible passage or clear clips for a storage failure', async () => {
    await recordAll();
    h.scroll.mockClear();
    h.enroll.mockResolvedValueOnce({ ok: false, reason: 'storage_unavailable' });
    await click('enroll.submit'); await frame();
    expect(h.scroll).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) expect(node(`enroll.step.${i}`).getAttribute('aria-label')).toContain('已录音');
    expect((node('enroll.submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the Android viewport without subtracting a native iOS header', async () => {
    h.platform = 'android'; await recordAll();
    h.enroll.mockResolvedValueOnce({ ok: false, reason: 'too_short', clipIndex: 0 });
    h.passageY = -100; h.onScroll?.({ nativeEvent: { contentOffset: { y: 300 } } });
    await click('enroll.submit'); await frame();
    expect(h.scroll).toHaveBeenLastCalledWith({ y: 184, animated: false });
  });
});
