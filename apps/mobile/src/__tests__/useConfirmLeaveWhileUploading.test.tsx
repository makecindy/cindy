// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmLeaveWhileUploading } from '@/session/useConfirmLeaveWhileUploading';
import { useSessionSendNavigation } from '@/session/useSessionSendNavigation';

const h = vi.hoisted(() => ({
  prevent: vi.fn(),
  alert: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('react-native', () => ({ Alert: { alert: h.alert } }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: h.dispatch }) }));
vi.mock('expo-router/react-navigation', () => ({ usePreventRemove: h.prevent }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mount(active: boolean) {
  let waitForLeaveDecision!: () => Promise<boolean>;
  function Harness() {
    waitForLeaveDecision = useConfirmLeaveWhileUploading(active);
    return null;
  }
  act(() => root.render(<Harness />));
  const [enabled, onPrevent] = h.prevent.mock.calls.at(-1)!;
  const action = { type: 'GO_BACK' };
  const leave = () => onPrevent({ data: { action } });
  const choose = (style: 'cancel' | 'destructive') => act(() => h.alert.mock.calls.at(-1)![2]
    .find((button: { style?: string }) => button.style === style).onPress());
  return { enabled, leave, choose, action, waitForLeaveDecision, dismiss: () => h.alert.mock.calls.at(-1)![3].onDismiss() };
}

// Unit, PR #11841: both native Back and in-place navigation can arrive before the
// durable handoff finishes. The upload-dialog tests do not exercise either ordering.
it('replays the first departure once and drops a stale departure after a scope change', () => {
  let nav!: ReturnType<typeof useSessionSendNavigation>;
  function Session({ scope }: { scope: string }) {
    nav = useSessionSendNavigation(scope);
    return null;
  }
  act(() => root.render(<Session scope="A" />));
  let finish!: ReturnType<typeof nav.beginSendHandoff>;
  const back = vi.fn();
  const drawer = vi.fn();
  act(() => { finish = nav.beginSendHandoff(); });
  const [active, nativeBack] = h.prevent.mock.calls.at(-1)!;
  expect(active).toBe(true);
  nativeBack({ data: { action: { type: 'GO_BACK' } }, repeat: back });
  expect(nav.deferSendNavigation(drawer)).toBe(true);
  expect(back).not.toHaveBeenCalled();
  act(() => { finish(); finish(); });
  expect(back).toHaveBeenCalledOnce();
  expect(drawer).not.toHaveBeenCalled();
  expect(h.prevent.mock.calls.at(-1)![0]).toBe(false);

  act(() => { finish = nav.beginSendHandoff(); });
  expect(nav.deferSendNavigation(drawer)).toBe(true);
  act(() => root.render(<Session scope="B" />));
  act(() => { finish(); });
  expect(drawer).not.toHaveBeenCalled();
  expect(nav.deferSendNavigation(drawer)).toBe(false);

  // When a send aborts to show an error or model sheet, release the guard without leaving.
  act(() => { finish = nav.beginSendHandoff(); });
  expect(nav.deferSendNavigation(drawer)).toBe(true);
  act(() => { expect(finish(false)).toBe(false); });
  expect(drawer).not.toHaveBeenCalled();
  expect(h.prevent.mock.calls.at(-1)![0]).toBe(false);
});

describe('useConfirmLeaveWhileUploading', () => {
  it('only blocks leaving while a send waits on uploads', () => {
    expect(mount(false).enabled).toBe(false);
    expect(mount(true).enabled).toBe(true);
  });

  it('lets the send continue when nobody tried to leave', async () => {
    await expect(mount(true).waitForLeaveDecision()).resolves.toBe(false);
  });

  // The native alert stays open after an upload settles, so the send must wait for the choice.
  it('holds the send until the open dialog is answered', async () => {
    const stay = mount(true);
    stay.leave();
    let settled: boolean | undefined;
    const waiting = stay.waitForLeaveDecision().then((value) => { settled = value; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    stay.choose('cancel');
    await waiting;
    expect(settled).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();

    const discard = mount(true);
    discard.leave();
    const discarding = discard.waitForLeaveDecision();
    discard.choose('destructive');
    await expect(discarding).resolves.toBe(true);
    expect(h.dispatch).toHaveBeenCalledWith(discard.action);
    await expect(discard.waitForLeaveDecision()).resolves.toBe(true);
  });

  // Regression: dispatch alone left the upload guard enabled, so another remove
  // event reopened the alert. Unit tier: mount the real hook with pending uploads.
  it('disables the guard before replaying a confirmed departure with uploads still pending', async () => {
    const harness = mount(true);
    h.dispatch.mockImplementationOnce(() => {
      const [enabled, onPrevent] = h.prevent.mock.calls.at(-1)!;
      if (enabled) onPrevent({ data: { action: harness.action } });
      expect(enabled).toBe(false);
    });
    harness.leave();
    const waiting = harness.waitForLeaveDecision();
    harness.choose('destructive');
    await expect(waiting).resolves.toBe(true);
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(harness.action);
    expect(h.alert).toHaveBeenCalledTimes(1);
    await expect(harness.waitForLeaveDecision()).resolves.toBe(true);
  });

  it('ignores a late dismissal from an already answered dialog', async () => {
    const harness = mount(true);
    harness.leave();
    const dismissOldDialog = h.alert.mock.calls.at(-1)![3].onDismiss;
    harness.choose('cancel');
    harness.leave();
    dismissOldDialog();
    let resolved = false;
    const waiting = harness.waitForLeaveDecision().then((value) => { resolved = true; return value; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    harness.choose('destructive');
    await expect(waiting).resolves.toBe(true);
  });

  it('treats dismissing the dialog as keep waiting, and never stacks a second dialog', async () => {
    const harness = mount(true);
    harness.leave();
    harness.leave();
    expect(h.alert).toHaveBeenCalledTimes(1);
    const waiting = harness.waitForLeaveDecision();
    harness.dismiss();
    await expect(waiting).resolves.toBe(false);
    harness.leave();
    expect(h.alert).toHaveBeenCalledTimes(2);
  });
});
