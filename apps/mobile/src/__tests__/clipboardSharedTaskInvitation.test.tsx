// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, invalidateMobileAuthOwnerForSwitch as invalidateOwner, setMobileAuthOwner as setOwner } from '@/auth/authOwnerGeneration';
import { __testing as historyTesting, invitationDigest } from '@/device-link/clipboardInvitationHistory';
import { useClipboardSharedTaskInvitation } from '@/device-link/useClipboardSharedTaskInvitation';
import { ClipboardSharedTaskPrompt } from '@/session/ClipboardSharedTaskPrompt';
import { clearSharedTaskInvitationIntent as clearIntent, confirmClipboardSharedTaskInvitation as confirmIntent, getPendingSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent as receiveIntent } from '@/device-link/sharedTaskInvitationIntent';

// Store events now drive a mounted confirmation component as well as the hook.
function inAct<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
  return (...args: Args): Result => {
    let result!: Result;
    act(() => { result = operation(...args); });
    return result;
  };
}
const clearSharedTaskInvitationIntent = inAct(clearIntent);
const confirmClipboardSharedTaskInvitation = inAct(confirmIntent);
const receiveSharedTaskInvitationIntent = inAct(receiveIntent);
const setMobileAuthOwner = inAct(setOwner);
const invalidateMobileAuthOwnerForSwitch = inAct(invalidateOwner);

const h = vi.hoisted(() => ({ read: vi.fn(), state: 'active', listener: null as null | ((state: string) => void), autoShow: true, onShow: undefined as (() => void) | undefined }));
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('expo-clipboard', () => ({ getStringAsync: h.read }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('@/session/SharedTaskScreen', () => ({
  SharedTaskAction: ({ action }: { action: { label: string; onPress(): void } }) => createElement('button', { onClick: action.onPress }, action.label),
}));
vi.mock('react-native', () => ({
  Modal: ({ children, onShow }: { children?: ReactNode; onShow?(): void }) => {
    useEffect(() => {
      h.onShow = onShow;
      if (h.autoShow) onShow?.();
    }, []);
    return createElement('div', { role: 'dialog' }, children);
  },
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (value: unknown) => value },
  AppState: {
  get currentState() { return h.state; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    h.listener = listener; return { remove: () => { if (h.listener === listener) h.listener = null; } };
  },
} }));
const token = 'A'.repeat(43);
const link = 'https://relay.example.test/shared-task/join#' + token;
let root: Root;
function Harness({ enabled, joining, promptVisible }: { enabled: boolean; joining: boolean; promptVisible: boolean }) {
  useClipboardSharedTaskInvitation(enabled, joining);
  // Same visibility boundary as NavigationGate while its startup splash is active.
  return enabled && promptVisible ? createElement(ClipboardSharedTaskPrompt) : null;
}
async function render(enabled = true, joining = false, promptVisible = true) {
  await act(async () => root.render(createElement(Harness, { enabled, joining, promptVisible })));
}
async function state(next: string) { await act(async () => { h.state = next; h.listener?.(next); }); }
beforeEach(() => {
  historyTesting.reset(); storage.values.clear();
  h.autoShow = true; h.onShow = undefined;
  storage.getItem.mockReset().mockImplementation(async (key: string) => storage.values.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => { storage.values.set(key, value); });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); h.read.mockReset(); h.read.mockResolvedValue(link); h.state = 'active';
  clearSharedTaskInvitationIntent(); setMobileAuthOwner('guest');
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); clearSharedTaskInvitationIntent(); await historyTesting.flush(); vi.useRealTimers(); });

it('reads on startup and identifies the invitation as clipboard admission', async () => {
  await render();
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it('recognizes an invitation message whose task title contains an ordinary URL', async () => {
  h.read.mockResolvedValue(`邀请你加入「检查 https://docs.example.test/page」\n${link}\n复制后打开 Cindy`);
  await render();
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it.each(['before-mount', 'before-login', 'while-running'] as const)('does not reoffer an explicit invitation from the clipboard: %s', async when => {
  const intent = 'cindy://shared-session?invitation=' + token + '&server=https%3A%2F%2Frelay.example.test';
  h.read.mockResolvedValue('');
  if (when !== 'before-mount') await render(when !== 'before-login');
  await act(async () => { receiveSharedTaskInvitationIntent(intent); });
  if (when === 'before-mount') await render();
  clearSharedTaskInvitationIntent(); // Explicit admission has consumed the link.
  h.read.mockResolvedValue(link);
  await render(); await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  // Dedupe does not block explicit retry or a newly copied invitation.
  expect(receiveSharedTaskInvitationIntent(intent)).toBe(true);
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'link' });
  clearSharedTaskInvitationIntent(); h.read.mockResolvedValue(link.replace(token, 'B'.repeat(43)));
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: 'B'.repeat(43), source: 'clipboard' });
});
it('does not let a foreign-server explicit invitation suppress the current service clipboard', async () => {
  receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + token + '&server=https%3A%2F%2Fother.example.test');
  await render(); clearSharedTaskInvitationIntent();
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it.each(['account', 'new-link', 'expired'] as const)('ignores confirmation after the visible clipboard invitation is superseded by %s', async reason => {
  await render();
  const id = getPendingSharedTaskInvitationIntent()!.id;
  await act(async () => {
    if (reason === 'account') invalidateMobileAuthOwnerForSwitch();
    if (reason === 'new-link') receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test', 'clipboard');
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(15 * 60_000);
    confirmClipboardSharedTaskInvitation(id);
  });
  if (reason === 'new-link') expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: 'B'.repeat(43), source: 'clipboard' });
  else expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it('reads on foreground, deduplicates consumed links, and detects a newly copied link', async () => {
  await render(); clearSharedTaskInvitationIntent();
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  h.read.mockResolvedValue(link.replace(token, 'B'.repeat(43)));
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe('B'.repeat(43));
  clearSharedTaskInvitationIntent(); h.read.mockResolvedValue(link);
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it.each(['hello', token, link.replace('relay.example.test', 'other.example.test'), link + '?app=unknown'])('ignores ordinary or incompatible clipboard content: %s', async text => {
  h.read.mockResolvedValue(text); await render(); expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it('does not reread after an inactive/active permission prompt', async () => {
  await render(); clearSharedTaskInvitationIntent();
  await state('inactive'); await state('active'); expect(h.read).toHaveBeenCalledTimes(1);
});
it('offers the first allowed clipboard invitation when the permission prompt returns to active', async () => {
  let finish!: (text: string) => void;
  h.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await state('inactive');
  await act(async () => finish(link));
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
  expect(h.read).toHaveBeenCalledTimes(1);
});
it('does not offer a permission-prompt result after a link invitation replaces it', async () => {
  let finish!: (text: string) => void;
  h.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await state('inactive');
  await act(async () => finish(link));
  receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test');
  await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: 'B'.repeat(43), source: 'link' });
  expect(h.read).toHaveBeenCalledTimes(1);
});
it('rereads for a new account after a permission prompt returns to active', async () => {
  const finishes: Array<(text: string) => void> = [];
  h.read.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  await render(); await state('inactive');
  await act(async () => finishes[0](link));
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  await state('active');
  expect(h.read).toHaveBeenCalledTimes(2);
  await act(async () => finishes[1](link.replace(token, 'B'.repeat(43))));
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: 'B'.repeat(43), source: 'clipboard' });
});
it('waits for login and leaves an open admission form alone', async () => {
  await render(false); expect(h.read).not.toHaveBeenCalled();
  await render(true, true); expect(h.read).not.toHaveBeenCalled();
});
it.each(['account', 'manual', 'link'] as const)('discards delayed clipboard results superseded by %s', async reason => {
  let finish!: (text: string) => void;
  h.read.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render();
  if (reason === 'account') setMobileAuthOwner('another');
  if (reason === 'manual') await render(true, true);
  if (reason === 'link') {
    receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test');
    clearSharedTaskInvitationIntent();
  }
  await act(async () => finish(link)); expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  // The superseded result must not consume this invitation. A fresh read can offer it.
  if (reason === 'account') {
    expect(h.read).toHaveBeenCalledTimes(2);
    await act(async () => finish(link));
  } else {
    h.read.mockResolvedValue(link);
    await render(true, false);
    await state('background'); await state('active');
  }
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it('checks again when an account switch settles in the foreground', async () => {
  invalidateMobileAuthOwnerForSwitch();
  await render(); expect(h.read).not.toHaveBeenCalled();
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it('lets the old pending invitation clear before reading for the new account', async () => {
  await render();
  const next = 'B'.repeat(43);
  h.read.mockResolvedValue(link.replace(token, next));
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: next, source: 'clipboard' });
});
it('does not read on logout or after unmounting the owner subscription', async () => {
  await render();
  await act(async () => { setMobileAuthOwner(null); await vi.runAllTicks(); });
  expect(h.read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  expect(h.read).toHaveBeenCalledTimes(1);
});
it('ignores clipboard denial without interrupting the app', async () => {
  h.read.mockRejectedValue(new Error('Clipboard unavailable')); await render();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});

async function restart() {
  await act(async () => root.unmount());
  clearSharedTaskInvitationIntent();
  await historyTesting.flush();
  // Discard ALL history cache/hydration/queue state, retaining only simulated disk.
  historyTesting.reset();
  setMobileAuthOwner(null); setMobileAuthOwner('guest');
  root = createRoot(document.createElement('div'));
  await render();
}

it.each(['dismissed', 'joined'] as const)('does not reoffer a %s invitation after cold-start cache reset', async action => {
  await render();
  if (action === 'joined') confirmClipboardSharedTaskInvitation(getPendingSharedTaskInvitationIntent()!.id);
  clearSharedTaskInvitationIntent(); // Dismissal, or admission consumed after joining.
  await restart();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  expect(storage.getItem).toHaveBeenCalledTimes(2);
  h.read.mockResolvedValue(link.replace(token, 'B'.repeat(43)));
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe('B'.repeat(43));
});

it('deduplicates the token despite a changed title and A to B to A clipboard changes across restarts', async () => {
  await render();
  await restart();
  h.read.mockResolvedValue(link.replace(token, 'B'.repeat(43)));
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe('B'.repeat(43));
  clearSharedTaskInvitationIntent();
  h.read.mockResolvedValue(`A different title\n${link}`);
  await restart();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});

it('offers the same token to a different account and remembers each account separately', async () => {
  await render(); clearSharedTaskInvitationIntent();
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(token);
  clearSharedTaskInvitationIntent();
  await act(async () => { setMobileAuthOwner('guest'); await vi.runAllTicks(); });
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  await restart();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  expect(storage.values.size).toBe(2);
});

it.each(['account', 'same-account-generation', 'logout', 'link', 'manual', 'background', 'unmount'] as const)(
  'discards a history read superseded by %s without recording the stale offer', async reason => {
    let finish!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const oldKey = historyTesting.storageKey(getMobileAuthOwner().accountKey);
    // Subsequent fresh reads must not offer the stale clipboard value either.
    h.read.mockResolvedValue('');
    if (reason === 'account') setMobileAuthOwner('another');
    if (reason === 'same-account-generation') { invalidateMobileAuthOwnerForSwitch(); setMobileAuthOwner('guest'); }
    if (reason === 'logout') setMobileAuthOwner(null);
    if (reason === 'link') {
      receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test');
      clearSharedTaskInvitationIntent();
    }
    if (reason === 'manual') await render(true, true);
    if (reason === 'background') await state('background');
    if (reason === 'unmount') await act(async () => root.render(null));
    await act(async () => { finish(null); await vi.runAllTicks(); });
    await historyTesting.flush();
    expect(getPendingSharedTaskInvitationIntent()).toBeNull();
    expect(storage.values.get(oldKey) ?? '').not.toContain(invitationDigest(token));
  },
);

it('persists an explicit link claimed at first login, without suppressing explicit retries', async () => {
  setMobileAuthOwner(null);
  await render(false);
  const url = 'cindy://shared-session?invitation=' + token + '&server=https%3A%2F%2Frelay.example.test';
  receiveSharedTaskInvitationIntent(url);
  expect(storage.setItem).not.toHaveBeenCalled();
  await act(async () => { setMobileAuthOwner('guest'); await vi.runAllTicks(); });
  await render(); clearSharedTaskInvitationIntent();
  await restart();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  expect(receiveSharedTaskInvitationIntent(url)).toBe(true);
  expect(getPendingSharedTaskInvitationIntent()?.source).toBe('link');
});

it('does not attribute an old explicit link to the next account', async () => {
  h.read.mockResolvedValue(''); await render();
  receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + token + '&server=https%3A%2F%2Frelay.example.test');
  await act(async () => { setMobileAuthOwner('another'); await vi.runAllTicks(); });
  await historyTesting.flush();
  expect(storage.values.has(historyTesting.storageKey(getMobileAuthOwner().accountKey))).toBe(false);
});

it.each(['getItem', 'setItem'] as const)('keeps admission usable when %s fails', async method => {
  storage[method].mockRejectedValue(new Error('storage unavailable'));
  await render();
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(token);
  clearSharedTaskInvitationIntent();
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  await restart();
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(token);
});

it('offers an unseen invitation after restart when the startup splash prevented presentation', async () => {
  await render(true, false, false);
  expect(getPendingSharedTaskInvitationIntent()?.source).toBe('clipboard');
  expect(h.onShow).toBeUndefined();
  await historyTesting.flush();
  expect(storage.setItem).not.toHaveBeenCalled();
  await restart();
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe(token);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

it('waits for native onShow even after mounting, then suppresses the displayed invitation after restart', async () => {
  h.autoShow = false;
  await render(true, false, false);
  await render(); // Startup splash is released; native presentation is still pending.
  expect(h.onShow).toBeDefined();
  await historyTesting.flush();
  expect(storage.setItem).not.toHaveBeenCalled();
  await act(async () => h.onShow?.());
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  await restart();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});

it.each(['new-link', 'account', 'same-account-generation', 'dismiss', 'expired', 'unmount'] as const)(
  'ignores a delayed native onShow after %s', async reason => {
    h.autoShow = false;
    await render();
    const shown = h.onShow!;
    h.read.mockResolvedValue('');
    await act(async () => {
      if (reason === 'new-link') receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test', 'clipboard');
      if (reason === 'account') setMobileAuthOwner('another');
      if (reason === 'same-account-generation') { invalidateMobileAuthOwnerForSwitch(); setMobileAuthOwner('guest'); }
      if (reason === 'dismiss') clearSharedTaskInvitationIntent();
      if (reason === 'expired') await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.runAllTicks();
    });
    if (reason === 'unmount') await render(true, false, false);
    await act(async () => shown());
    await historyTesting.flush();
    expect(storage.setItem).not.toHaveBeenCalled();
  },
);

it('registers presentation for the replacement invitation independently', async () => {
  h.autoShow = false;
  await render();
  const oldShow = h.onShow!;
  await act(async () => {
    receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test', 'clipboard');
  });
  const newShow = h.onShow!;
  expect(newShow).not.toBe(oldShow);
  await act(async () => { oldShow(); newShow(); });
  await historyTesting.flush();
  const raw = [...storage.values.values()].join('');
  expect(raw).not.toContain(invitationDigest(token));
  expect(raw).toContain(invitationDigest('B'.repeat(43)));
});
