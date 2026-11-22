// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePromptRecommendation } from '@/session/usePromptRecommendation';
import { createComposerDraftSource } from '@/session/composerDraftSource';
import { textComposerDocument } from '@/session/composerDocument';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { __testing as preferenceTesting, savePromptRecommendationPreference, usePromptRecommendationPreference } from '@/session/promptRecommendationPreference';
import { PromptRecommendationSettings } from '@/settings/PromptRecommendationSettings';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Exercise the real settings and prediction hooks with DOM adapters for native rows.
vi.mock('@/session/SettingsGroupRows', () => ({
  SettingsGroup: ({ children, messages }: any) => createElement('section', null, children,
    messages?.filter(Boolean).map((message: any) => createElement('p', { key: message.text }, message.text))),
  SettingsSwitchRow: ({ label, disabled, value, onValueChange }: any) => createElement('button', {
    role: 'switch', 'aria-label': label, 'aria-checked': value, disabled, onClick: () => onValueChange(!value),
  }),
  ActionInfoRow: ({ label, onPress, disabled }: any) => createElement('button', { disabled, onClick: onPress }, label),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let props: Parameters<typeof usePromptRecommendation>[0];
let value: ReturnType<typeof usePromptRecommendation>;
let request: ReturnType<typeof vi.fn>;
let sequence = 0;
let container: HTMLDivElement;
let showSettings = false;
let preference: ReturnType<typeof usePromptRecommendationPreference>;
function Probe() {
  value = usePromptRecommendation(props);
  preference = usePromptRecommendationPreference();
  return showSettings ? createElement(PromptRecommendationSettings) : null;
}
async function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(Probe)));
}
async function advance() { await act(async () => vi.advanceTimersByTimeAsync(500)); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  storage.clear();
  preferenceTesting.reset();
  showSettings = false;
  request = vi.fn().mockResolvedValue({ prompt: 'Suggested next step' });
  props = { ownerId: 'owner', deviceId: 'host', sessionId: `task-${++sequence}`, agentKind: 'codex',
    revision: 10, running: false, maker: { predictNextPrompt: request } };
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

// Regression: mobile had no persistent opt-out. Existing prediction tests cover
// task lifecycle only. These unit cases use the actual settings/store/hook to
// verify no requests or visible suggestions after opt-out, including cold reads
// and late responses, plus persistence/reset and write errors (in-memory storage).
// Standalone run: 42 cases, 2.13s wall-clock on the development machine.
it('preserves the original enabled default, remembers opt-out, and resets back to enabled', async () => {
  showSettings = true;
  await render(); await advance();
  expect(value.prompt).toBeTruthy();
  expect(storage.size).toBe(0);
  expect(preference.customized).toBe(false);
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle().click());
  expect(value.prompt).toBeNull();
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(storage.get(preferenceTesting.storageKey)).toBe('false');
  await act(async () => root.render(null));
  preferenceTesting.reset();
  await render();
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button:not([role])')!.click());
  expect(storage.has(preferenceTesting.storageKey)).toBe(false);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(preference.customized).toBe(false);
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 30 }));
  expect(value.prompt).toBeTruthy();
});

it('does not request anything before a slow saved opt-out is read', async () => {
  let resolve!: (raw: string | null) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await act(async () => resolve('false'));
  await advance();
  expect(request).not.toHaveBeenCalled();
  expect(value.prompt).toBeNull();
});

// Review regression: loading is not opt-out. A completed live turn must still
// generate once when a delayed read confirms the default or explicit opt-in.
it.each([null, 'true'])('preserves a live completion while preference loading resolves to %s', async (raw) => {
  let resolve!: (raw: string | null) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await act(async () => resolve(raw));
  await advance();
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    cacheOnly: false, completionRevision: 20,
  }));
  expect(value.prompt).toBe('Suggested next step');
});

// Review regression: failed removal must leave a usable reset action, so users
// can persist the default without toggling to an unwanted value first.
it('keeps reset available after removal fails and lets the user retry', async () => {
  storage.set(preferenceTesting.storageKey, 'false');
  showSettings = true;
  await render();
  vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('disk full'));
  const reset = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === 'settings.promptRecommendation.reset');
  await act(async () => reset()!.click());
  expect(preference.enabled).toBe(true);
  expect(storage.get(preferenceTesting.storageKey)).toBe('false');
  expect(container.textContent).toContain('settings.promptRecommendation.saveFailed');
  expect(reset()).toBeDefined();
  expect(reset()!.disabled).toBe(false);
  await act(async () => reset()!.click());
  expect(storage.has(preferenceTesting.storageKey)).toBe(false);
  expect(reset()).toBeUndefined();
  expect(container.textContent).not.toContain('settings.promptRecommendation.saveFailed');
  await act(async () => root.render(null));
  preferenceTesting.reset();
  await render();
  expect(preference).toMatchObject({ ready: true, enabled: true, customized: false });
});

it('does not let an older reset clear a newer explicit choice', async () => {
  storage.set(preferenceTesting.storageKey, 'false');
  await render();
  let completeRemoval!: () => void;
  vi.mocked(AsyncStorage.removeItem).mockImplementationOnce(key => new Promise(done => {
    completeRemoval = () => { storage.delete(key); done(); };
  }));
  let reset!: Promise<void>;
  await act(async () => { reset = savePromptRecommendationPreference(null); });
  let disable!: Promise<void>;
  await act(async () => { disable = savePromptRecommendationPreference(false); });
  await act(async () => { completeRemoval(); await Promise.all([reset, disable]); });
  expect(preference).toMatchObject({ enabled: false, customized: true });
  expect(storage.get(preferenceTesting.storageKey)).toBe('false');
});

it('cancels a scheduled prediction when disabled', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 });
  await act(async () => { await savePromptRecommendationPreference(false); });
  expect(vi.getTimerCount()).toBe(0);
  await advance();
  expect(request).not.toHaveBeenCalled();
});

it('drops an in-flight result after disabling and only reads cache when re-enabled', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await act(async () => { await savePromptRecommendationPreference(false); });
  await act(async () => resolve({ prompt: 'Late suggestion' }));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(value.prompt).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { await savePromptRecommendationPreference(true); });
  await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
  expect(value.prompt).toBe('Suggested next step');
});

it('clears an already scheduled cache retry when disabled', async () => {
  request.mockResolvedValue({ prompt: null });
  await render(); await advance();
  await act(async () => { await savePromptRecommendationPreference(false); });
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(request).toHaveBeenCalledTimes(1);
});

it('reports save failure in settings while retaining the choice for this process', async () => {
  showSettings = true;
  await render();
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle.click());
  expect(container.textContent).toContain('settings.promptRecommendation.saveFailed');
  expect(preference.enabled).toBe(false);
  await advance();
  expect(request).not.toHaveBeenCalled();
  await act(async () => toggle.click());
  expect(storage.get(preferenceTesting.storageKey)).toBe('true');
  expect(container.textContent).not.toContain('settings.promptRecommendation.saveFailed');
});

it('keeps an explicit choice over a late initial read and serializes rapid changes', async () => {
  let resolve!: (raw: string | null) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render();
  await act(async () => { await Promise.all([
    savePromptRecommendationPreference(true), savePromptRecommendationPreference(false),
  ]); });
  await act(async () => resolve('true'));
  expect(preference.enabled).toBe(false);
  expect(storage.get(preferenceTesting.storageKey)).toBe('false');
  await advance();
  expect(request).not.toHaveBeenCalled();
});

it('does not turn unread preferences into paid requests when storage fails', async () => {
  vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  expect(value.prompt).toBeNull();
});

it('historical navigation only requests a cached host result', async () => {
  await render(); await advance();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ cacheOnly: true, completionRevision: 10 }));
  expect(value.prompt).toBe('Suggested next step');
});

it.each(['queueEditing', 'hasAttachments', 'voiceIsBusy'] as const)(
  'defers prediction and hides retained results while %s is active', async (blocker) => {
  await render({ [blocker]: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
  await render({ [blocker]: true }); await advance();
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false }); await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['queueEditing', 'hasAttachments', 'voiceIsBusy'] as const)(
  'hides a prediction that resolves after %s begins', async (blocker) => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await render({ [blocker]: true });
  await act(async () => resolve({ prompt: 'Late suggestion' }));
  expect(value.prompt).toBeNull();
  await render({ [blocker]: false });
  expect(value.prompt).toBe('Late suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('waits for the new completion revision even when stopped arrives first', async () => {
  await render({ running: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: false }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
  await render({ revision: 20 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 20 }));
});

it('metadata refresh after opening cached history stays cache-only, including retries', async () => {
  request.mockResolvedValue({ prompt: null });
  await render(); await advance();
  await render({ revision: 20 }); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(request).toHaveBeenCalledTimes(5);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
});

it('an observed run authorizes only its completion, and a later run can predict again', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 20 }));
  await render({ revision: 30 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true, completionRevision: 30 }));
  await render({ running: true });
  await render({ running: false, revision: 40 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: false, completionRevision: 40 }));
});

it('defers prediction during voice input and permits it after voice ends', async () => {
  await render({ running: true, voiceIsBusy: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ voiceIsBusy: false }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('starting voice defers a scheduled request and retains an already pending result', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 });
  await render({ voiceIsBusy: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: true, voiceIsBusy: false });
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: false, revision: 30 }); await advance();
  await render({ voiceIsBusy: true });
  await act(async () => resolve({ prompt: 'Retained suggestion' }));
  await render({ voiceIsBusy: false }); await advance();
  expect(value.prompt).toBe('Retained suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('dismissal or sending rejects late results and survives a page remount', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await act(async () => value.dismiss());
  await act(async () => resolve({ prompt: 'Late suggestion' }));
  expect(value.prompt).toBeNull();
  await act(async () => root.render(null));
  await render(); await advance();
  expect(value.prompt).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('does not show a previous task result while changing task or running again', async () => {
  await render(); await advance();
  expect(value.prompt).toBeTruthy();
  await render({ sessionId: `${props.sessionId}-other` });
  expect(value.prompt).toBeNull();
  await advance();
  await render({ running: true });
  expect(value.prompt).toBeNull();
});

it('owner and device changes cannot reuse a dismissed revision or an old promise', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(); await advance();
  await render({ ownerId: 'other', deviceId: 'other-host' });
  await act(async () => resolve({ prompt: 'Wrong owner' }));
  expect(value.prompt).toBeNull();
  await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('old hosts without the channel fail silently', async () => {
  request.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
  await render(); await advance();
  expect(value.prompt).toBeNull();
});

it('keeps live completion eligibility when its timestamp settles during debounce', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20 });
  await act(async () => vi.advanceTimersByTimeAsync(18));
  await render({ revision: 38 });
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
    cacheOnly: false, completionRevision: 38,
  }));
  expect(value.prompt).toBe('Suggested next step');
  await render({ revision: 50 }); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
});

it('waits for connectivity before requesting a just-completed turn', async () => {
  await render({ running: true, available: false });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ available: true }); await advance();
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    completionRevision: 20, cacheOnly: false,
  }));
  expect(value.prompt).toBe('Suggested next step');
});

it('recovers a failed live request from host cache after reconnect without paying twice', async () => {
  request.mockRejectedValueOnce(new Error('DEVICE_LINK_NOT_CONNECTED'));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  expect(value.prompt).toBeNull();
  await render({ available: false });
  await render({ available: true }); await advance();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
    completionRevision: 20, cacheOnly: true,
  }));
  expect(value.prompt).toBe('Suggested next step');
});

it('recovers when the old request fails after a new connection is already ready', async () => {
  let reject!: (reason: Error) => void;
  request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await render({ connectionEpoch: 1 }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('INVOKE_TIMEOUT')));
  await advance();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
  expect(value.prompt).toBe('Suggested next step');
});

it('does not retry link failures on timers, ordinary transport refreshes or draft interaction', async () => {
  request.mockRejectedValue(new Error('INVOKE_TIMEOUT'));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await render({ maker: { predictNextPrompt: request } });
  await render({ hasAttachments: true });
  await render({ hasAttachments: false });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(1);
  await render({ connectionEpoch: 1 }); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
});

it('keeps a deferred recovery cache-only when input cancels its debounce', async () => {
  request.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await render({ connectionEpoch: 1 });
  await render({ hasAttachments: true }); await advance();
  await render({ hasAttachments: false }); await advance();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cacheOnly: true }));
});

it('retains an in-flight success through reconnect without another request', async () => {
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await render({ available: false });
  await render({ available: true, connectionEpoch: 1 }); await advance();
  await act(async () => resolve({ prompt: 'Recovered result' }));
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Recovered result');
});

it('does not restore dismissed recommendations after a failed request and reconnect', async () => {
  request.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
  await render({ running: true });
  await render({ running: false, revision: 20 }); await advance();
  await act(async () => value.dismiss());
  await render({ connectionEpoch: 1 }); await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBeNull();
});

it('resumes cache lookup after connectivity interrupts a bounded cache retry', async () => {
  request.mockResolvedValueOnce({ prompt: null });
  await render(); await advance();
  await render({ available: false });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(request).toHaveBeenCalledTimes(1);
  await render({ available: true }); await advance();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
  expect(value.prompt).toBe('Suggested next step');
});

it('consumes terminal failures without predicting, but permits the next successful turn', async () => {
  await render({ running: true });
  await render({ running: false, revision: 20, hasTerminalError: true });
  await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ hasTerminalError: false }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ running: true });
  await render({ running: false, revision: 30 }); await advance();
  expect(value.prompt).toBe('Suggested next step');
});

it('defers an occupied completion until the draft is cleared', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument('My next question'));
  await render({ running: true, composerSource });
  await render({ running: false, revision: 20 }); await advance();
  expect(request).not.toHaveBeenCalled();
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  // Draft occupancy is published on the next frame; let React commit it before
  // advancing the prediction's own debounce timer.
  await act(async () => vi.advanceTimersToNextFrame());
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(value.prompt).toBe('Suggested next step');
});

it('defers attachment-only input and retains results arriving after input is added', async () => {
  await render({ hasAttachments: true }); await advance();
  expect(request).not.toHaveBeenCalled();
  await render({ hasAttachments: false, running: true });
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: false, revision: 20 }); await advance();
  await render({ hasAttachments: true });
  await act(async () => resolve({ prompt: 'Retained suggestion' }));
  await render({ hasAttachments: false }); await advance();
  expect(value.prompt).toBe('Retained suggestion');
  expect(request).toHaveBeenCalledTimes(1);
});

it('retries a cache miss without promoting navigation to a paid request', async () => {
  request.mockResolvedValueOnce({ prompt: null });
  await render(); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
  expect(value.prompt).toBe('Suggested next step');
});

it('bounds cache retries and cancels them on dismissal', async () => {
  request.mockResolvedValue({ prompt: null });
  await render(); await advance();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(4);
  await render({ sessionId: props.sessionId + '-other' }); await advance();
  await act(async () => value.dismiss());
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(5);
});


it('finishes bounded cache retries while editing, then reuses the result after clearing', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  request.mockResolvedValueOnce({ prompt: null });
  await render({ composerSource }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([args]) => args.cacheOnly === true)).toBe(true);
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps retries bounded across repeated typing and clearing', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  request.mockResolvedValue({ prompt: null });
  await render({ composerSource }); await advance();
  for (let i = 0; i < 6; i++) {
    await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => composerSource.setDocument(textComposerDocument('')));
    await advance();
  }
  expect(request).toHaveBeenCalledTimes(4);
});

it('retains the same recommendation through typing, clearing and attachment changes without another request', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  await render({ composerSource }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('My draft')));
  expect(value.prompt).toBe('Suggested next step'); // Presentation owns temporary hiding.
  await render({ hasAttachments: true });
  expect(value.prompt).toBeNull();
  await render({ hasAttachments: false });
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBe('Suggested next step');
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => value.dismiss());
  await act(async () => composerSource.setDocument(textComposerDocument('More typing')));
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(value.prompt).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it('retains a prediction arriving during editing without dispatching it twice', async () => {
  const composerSource = createComposerDraftSource(textComposerDocument(''));
  let resolve!: (result: { prompt: string }) => void;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render({ running: true, composerSource });
  await render({ running: false, revision: 20 }); await advance();
  await act(async () => composerSource.setDocument(textComposerDocument('Typing')));
  await act(async () => composerSource.setDocument(textComposerDocument('')));
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ prompt: 'Still relevant' }));
  expect(value.prompt).toBe('Still relevant');
});
