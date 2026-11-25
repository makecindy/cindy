// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useSideChatPromotion } from '../session/useSideChatPromotion';

const h = vi.hoisted(() => ({ promote: vi.fn(), completed: vi.fn(), current: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => h.current }));

// Unit: exercises the production action hook used by the task's menu.
// Covers the new owner-only action's receipt, duplicate taps, old hosts and stale
// replies. Moving it from a keyed button to the task page also requires guarding
// a route change without unmounting. No native process or timer is needed.
function ActionProbe({ sessionId = 'child' }: { sessionId?: string }) {
  const action = useSideChatPromotion({ deviceId: 'device', sessionId, parentSessionId: 'parent',
    maker: { promoteSideChat: h.promote }, canPromote: true, onPromoted: h.completed });
  return <><button disabled={action.busy} onClick={() => void action.promote()}>promote</button>
    {action.error ? <p role="alert">{action.error}</p> : null}</>;
}
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); h.current = true;
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const render = (sessionId = 'child') => act(async () => root.render(<ActionProbe sessionId={sessionId} />));
const click = () => act(async () => host.querySelector('button')!.click());

it('waits for one host receipt before making the same conversation a main task', async () => {
  let finish!: () => void;
  h.promote.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click(); await click();
  expect(h.promote).toHaveBeenCalledExactlyOnceWith('child', 'parent');
  expect(h.completed).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(h.completed).toHaveBeenCalledTimes(1);
});

it.each([
  ['[DEVICE_LINK_CHANNEL_NOT_ALLOWED]', 'session.sideChat.unsupported'],
  ['[PRECONDITION_FAILED]', 'session.sideChat.promoteFailed'],
])('keeps the action available and explains %s without pretending it converted', async (error, message) => {
  h.promote.mockRejectedValue(new Error(error));
  await render(); await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(host.querySelector('button')!.disabled).toBe(false);
  expect(h.completed).not.toHaveBeenCalled();
});

it.each(['unmount', 'owner'])('ignores a late receipt after %s changes', async kind => {
  let finish!: () => void;
  h.promote.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click();
  if (kind === 'unmount') await act(async () => root.render(null));
  else h.current = false;
  await act(async () => finish());
  expect(h.completed).not.toHaveBeenCalled();
});

it('ignores a late receipt after navigating to another task without unmounting', async () => {
  let finish!: () => void;
  h.promote.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click();
  await render('next-child');
  expect(host.querySelector('button')!.disabled).toBe(false);
  await act(async () => finish());
  expect(h.completed).not.toHaveBeenCalled();
});
