import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetInputDeviceActionsForTests,
  dispatchInputDeviceAction,
  subscribeInputDeviceAction,
} from '../inputDeviceActions';

describe('inputDeviceActions', () => {
  afterEach(() => {
    __resetInputDeviceActionsForTests();
  });

  it('lets the newest subscriber consume a command first', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    subscribeInputDeviceAction(older);
    subscribeInputDeviceAction(newer);

    dispatchInputDeviceAction({ type: 'command', commandId: 'forkTask' });

    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it('continues to older subscribers when the newer one declines', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    subscribeInputDeviceAction(older);
    subscribeInputDeviceAction(newer);

    dispatchInputDeviceAction({ type: 'command', commandId: 'copyConversationMarkdown' });

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });
});
