// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ StyleSheet: { create: (v: unknown) => v }, View: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/theme', () => ({ lineHeight: {}, radius: {}, spacing: {}, typeScale: {}, useThemedStyles: () => ({}) }));
vi.mock('@/session/CompanionCardButton', () => ({ CompanionCardButton: () => null }));
import { CLOUD_HOME_UNREACHABLE_AFTER_MS, isMessageWaitingForCloudHome, useSustained } from '../session/CloudHomeUnreachableNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
const seen: boolean[] = [];
function Harness({ waiting }: { waiting: boolean }) { seen.push(useSustained(waiting)); return null; }
const render = (waiting: boolean) => act(() => root.render(<Harness waiting={waiting} />));
beforeEach(() => { vi.useFakeTimers(); seen.length = 0; root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('offers the switch only after a message has waited for the main computer the whole time', () => {
  render(true);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS - 1); });
  expect(seen.at(-1)).toBe(false);
  act(() => { vi.advanceTimersByTime(1); });
  expect(seen.at(-1)).toBe(true);
  // Delivered: the prompt goes away at once, and a new wait starts the clock again.
  render(false);
  expect(seen.at(-1)).toBe(false);
  render(true);
  expect(seen.at(-1)).toBe(false);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS / 2); });
  render(false); render(true);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS / 2); });
  expect(seen.at(-1)).toBe(false);
});

const target = { deviceId: 'mac', sessionId: 's1' };
const offline = { relayOnline: true, targetAvailable: false, deviceUnresponsive: false };
const record = (patch: Partial<Parameters<typeof isMessageWaitingForCloudHome>[0][number]> = {}) =>
  ({ deviceId: 'mac', item: { sessionId: 's1' }, state: 'queued', ...patch }) as Parameters<typeof isMessageWaitingForCloudHome>[0][number];

it('counts only a message the main computer has not taken, held because that computer is unreachable', () => {
  expect(isMessageWaitingForCloudHome([record()], target, offline)).toBe(true);
  expect(isMessageWaitingForCloudHome([record()], target, { ...offline, targetAvailable: null, deviceUnresponsive: true })).toBe(true);
  // The computer is online: holds for the phone's own sync / reconnect recovery do not count.
  expect(isMessageWaitingForCloudHome([record()], target, { ...offline, targetAvailable: true })).toBe(false);
  expect(isMessageWaitingForCloudHome([record()], target, { ...offline, targetAvailable: null })).toBe(false);
  // The phone itself is offline: switching computers would not help.
  expect(isMessageWaitingForCloudHome([record()], target, { ...offline, relayOnline: false })).toBe(false);
  // Already handed to the computer, only awaiting history confirmation or cleanup.
  expect(isMessageWaitingForCloudHome([record({ state: 'host-owned', historyConfirmed: true })], target, offline)).toBe(false);
  expect(isMessageWaitingForCloudHome([record({ state: 'host-owned', retrySafe: true })], target, offline)).toBe(false);
  expect(isMessageWaitingForCloudHome([record({ cleanupOutcome: 'accepted' })], target, offline)).toBe(false);
  // Stopped on its own failure: not held by the computer, offering a switch would not help.
  expect(isMessageWaitingForCloudHome([record({ state: 'failed' })], target, offline)).toBe(false);
  // Only the FIFO head counts: a message queued behind a stopped head is blocked by that head.
  expect(isMessageWaitingForCloudHome([record({ state: 'failed' }), record()], target, offline)).toBe(false);
  expect(isMessageWaitingForCloudHome([record({ suspended: true }), record()], target, offline)).toBe(false);
  expect(isMessageWaitingForCloudHome([record({ state: 'confirming' }), record()], target, offline)).toBe(false);
  // A head already taken by the computer does not hide the next message waiting behind it.
  expect(isMessageWaitingForCloudHome([record({ state: 'host-owned', historyConfirmed: true }), record()], target, offline)).toBe(true);
  // Drafts, cancellations and other chats.
  expect(isMessageWaitingForCloudHome([record({ suspended: true }), record({ cancelRequested: true })], target, offline)).toBe(false);
  expect(isMessageWaitingForCloudHome([record({ item: { sessionId: 's2' } as never })], target, offline)).toBe(false);
});
