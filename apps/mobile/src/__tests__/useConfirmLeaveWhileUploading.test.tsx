// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmLeaveWhileUploading } from '@/session/useConfirmLeaveWhileUploading';

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
  const choose = (style: 'cancel' | 'destructive') => h.alert.mock.calls.at(-1)![2]
    .find((button: { style?: string }) => button.style === style).onPress();
  return { enabled, leave, choose, action, waitForLeaveDecision, dismiss: () => h.alert.mock.calls.at(-1)![3].onDismiss() };
}

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
