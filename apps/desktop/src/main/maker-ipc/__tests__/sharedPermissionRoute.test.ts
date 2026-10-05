import { describe, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import {
  beginInteractionRoute,
  installDesktopInteractionHandler,
  type InteractionHandler,
} from '../interactionRouter';
import type { SharedPermission } from '../sharedPermission';

function setup() {
  let dispatch!: InteractionHandler;
  const session = {
    id: 'session',
    setInteractionListener(handler: InteractionHandler | null) {
      if (handler) dispatch = handler;
    },
  };
  let desktop!: SharedPermission;
  let im!: SharedPermission;
  const desktopHandler = vi.fn<InteractionHandler>((_request, shared) => {
    desktop = shared!;
    return shared!.result;
  });
  const imHandler = vi.fn<InteractionHandler>((_request, shared) => {
    im = shared!;
    return shared!.result;
  });
  installDesktopInteractionHandler(session, desktopHandler);
  const lease = beginInteractionRoute(session, {
    route: {
      sessionId: 'session',
      turnId: 'turn',
      origin: { kind: 'hook', source: 'future-im' },
      interactionSurface: 'channel-card',
      sourceDescription: '来源：测试群\n原消息：hello',
    },
    handle: imHandler,
  });
  const request = {
    kind: 'permission',
    requestId: 'req',
    toolName: 'Read',
    input: {},
  } as InteractionRequest;
  return {
    dispatch: () => dispatch(request),
    desktopHandler,
    imHandler,
    lease,
    get desktop() {
      return desktop;
    },
    get im() {
      return im;
    },
  };
}

describe('shared permission route', () => {
  it.each(['desktop', 'im'] as const)(
    'allows %s to answer one shared request and rejects the other answer',
    async (winner) => {
      const test = setup();
      const result = test.dispatch();
      expect(test.desktop).toBe(test.im);
      expect(test.desktopHandler.mock.calls[0][0]).toMatchObject({
        description: '来源：测试群\n原消息：hello',
      });
      expect(test.imHandler.mock.calls[0][0]).toEqual(test.desktopHandler.mock.calls[0][0]);
      expect(test[winner].decide({ kind: 'permission', behavior: 'allow' })).toBe(true);
      expect(
        test[winner === 'im' ? 'desktop' : 'im'].decide({ kind: 'permission', behavior: 'deny' }),
      ).toBe(false);
      await expect(result).resolves.toMatchObject({ behavior: 'allow' });
      test.lease.release();
    },
  );

  it('releases both prompts when the turn ends, and refuses late approval', async () => {
    const test = setup();
    const result = test.dispatch();
    test.lease.release('session_disposed');
    await expect(result).resolves.toMatchObject({ reason: 'session_disposed' });
    expect(test.desktop.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    await expect(test.im.result).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('applies a channel restriction before either confirmation is exposed', async () => {
    let dispatch!: InteractionHandler;
    const session = {
      id: 'restricted',
      setInteractionListener(handler: InteractionHandler | null) {
        if (handler) dispatch = handler;
      },
    };
    const desktop = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    const channel = vi.fn(desktop);
    installDesktopInteractionHandler(session, desktop);
    const lease = beginInteractionRoute(session, {
      route: {
        sessionId: 'restricted',
        turnId: 't',
        origin: { kind: 'im', channel: 'telegram' },
        interactionSurface: 'channel-card',
      },
      handle: channel,
      permissionGuard: () => ({ kind: 'permission', behavior: 'deny', reason: 'channel-policy' }),
    });
    await expect(
      dispatch({
        kind: 'permission',
        requestId: 'blocked',
        toolName: 'Bash',
        input: {},
      } as InteractionRequest),
    ).resolves.toMatchObject({ reason: 'channel-policy' });
    expect(desktop).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
    lease.release();
  });
});
