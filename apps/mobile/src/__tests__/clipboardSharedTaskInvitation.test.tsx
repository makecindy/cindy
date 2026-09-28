// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateMobileAuthOwnerForSwitch, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useClipboardSharedTaskInvitation } from '@/device-link/useClipboardSharedTaskInvitation';
import { clearSharedTaskInvitationIntent, confirmClipboardSharedTaskInvitation, getPendingSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';

const h = vi.hoisted(() => ({ read: vi.fn(), state: 'active', listener: null as null | ((state: string) => void) }));
vi.mock('expo-clipboard', () => ({ getStringAsync: h.read }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test' }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return h.state; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    h.listener = listener; return { remove: () => { if (h.listener === listener) h.listener = null; } };
  },
} }));
const token = 'A'.repeat(43);
const link = 'https://relay.example.test/shared-task/join#' + token;
let root: Root;
function Harness({ enabled, joining }: { enabled: boolean; joining: boolean }) {
  useClipboardSharedTaskInvitation(enabled, joining); return null;
}
async function render(enabled = true, joining = false) {
  await act(async () => root.render(createElement(Harness, { enabled, joining })));
}
async function state(next: string) { await act(async () => { h.state = next; h.listener?.(next); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); h.read.mockReset(); h.read.mockResolvedValue(link); h.state = 'active';
  clearSharedTaskInvitationIntent(); setMobileAuthOwner('guest');
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); clearSharedTaskInvitationIntent(); vi.useRealTimers(); });

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
