import { describe, expect, it, vi } from 'vitest';

import {
  deliverMountedBotRoute,
  type MountedBotRouteDeliveryDeps,
  type MountedBotRouteSnapshot,
} from '../botMountedRouteDelivery';

const row = {
  id: 'delivery-1',
  botId: 'bot-1',
  channelId: 'channel-1',
  routeId: 'route-1',
  sessionId: 'task-old',
  idempotencyKey: 'delivery-key-1',
  ownerGeneration: 7,
  attempts: 1,
};

function route(overrides: Partial<MountedBotRouteSnapshot> = {}): MountedBotRouteSnapshot {
  return {
    botId: 'bot-1',
    channelId: 'channel-1',
    currentSessionId: 'task-old',
    ownerGeneration: 7,
    principalKey: 'principal-1',
    threadKey: 'thread-1',
    capabilitiesJson: JSON.stringify({ deliveryKey: 'relay-address-1' }),
    routeStatus: 'active',
    channelKind: 'telegram',
    channelEnabled: true,
    channelConfigJson: JSON.stringify({
      ownership: 'local-adapter',
      accountKey: 'account-1',
    }),
    ...overrides,
  };
}

function setup(routeSnapshot = route()): {
  deps: MountedBotRouteDeliveryDeps;
  deliver: ReturnType<typeof vi.fn>;
  recordExternalDispatch: ReturnType<typeof vi.fn>;
  recordProgress: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(async () => ({
    ok: true as const,
    receipt: { messageId: 'message-1' },
  }));
  const recordExternalDispatch = vi.fn(async () => undefined);
  const recordProgress = vi.fn(async () => undefined);
  return {
    deps: {
      loadWorkingDir: vi.fn(async (sessionId: string) => `/worktrees/${sessionId}`),
      loadRoute: vi.fn(async () => routeSnapshot),
      deliver,
    },
    deliver,
    recordExternalDispatch,
    recordProgress,
  };
}

describe('deliverMountedBotRoute', () => {
  it('marks local adapter dispatch as duplicate-risk and preserves the chosen fallback task', async () => {
    const h = setup();
    await expect(deliverMountedBotRoute({
      row,
      persistedContent: 'delegation result',
      targetSessionId: 'task-fallback',
      mediaAbsPaths: ['/managed/a.png'],
      attempt: h,
    }, h.deps)).resolves.toEqual({ ok: true, receipt: { messageId: 'message-1' } });

    expect(h.recordExternalDispatch).toHaveBeenCalledWith({
      retrySafe: false,
      transport: 'local-adapter',
    });
    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'delivery-key-1',
      sessionId: 'task-fallback',
      workingDir: '/worktrees/task-fallback',
      mediaAbsPaths: ['/managed/a.png'],
    }));
  });

  it('fails closed when a recovery route changed task after the unknown outcome was recorded', async () => {
    const h = setup(route({ currentSessionId: 'task-new' }));
    await expect(deliverMountedBotRoute({
      row,
      persistedContent: 'possibly delivered final',
      targetSessionId: 'task-old',
      requireCurrentSessionMatch: true,
      attempt: h,
    }, h.deps)).resolves.toEqual(expect.objectContaining({
      ok: false,
      retryable: false,
      errorCode: 'STALE_ROUTE_TASK',
    }));
    expect(h.recordExternalDispatch).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('fails closed when route ownership changes between outbox claim and adapter dispatch', async () => {
    const h = setup(route({ ownerGeneration: 8 }));
    await expect(deliverMountedBotRoute({
      row,
      persistedContent: 'result',
      attempt: h,
    }, h.deps)).resolves.toEqual(expect.objectContaining({
      ok: false,
      retryable: false,
      errorCode: 'STALE_ROUTE_OWNER',
    }));
    expect(h.recordExternalDispatch).not.toHaveBeenCalled();
  });

  it('marks server relay delivery retry-safe and forwards its durable address', async () => {
    const h = setup(route({
      channelConfigJson: JSON.stringify({
        ownership: 'server-relay',
        accountKey: 'relay-account',
      }),
    }));
    await deliverMountedBotRoute({
      row,
      persistedContent: 'scheduled result',
      attempt: h,
    }, h.deps);

    expect(h.recordExternalDispatch).toHaveBeenCalledWith({
      retrySafe: true,
      transport: 'server-relay',
    });
    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({
      ownership: 'server-relay',
      accountKey: 'relay-account',
      deliveryKey: 'relay-address-1',
    }));
  });

  it('keeps WeChat local delivery retry-safe because the provider key is idempotent', async () => {
    const h = setup(route({ channelKind: 'wechat' }));
    await deliverMountedBotRoute({
      row,
      persistedContent: 'wechat result',
      attempt: h,
    }, h.deps);
    expect(h.recordExternalDispatch).toHaveBeenCalledWith({
      retrySafe: true,
      transport: 'local-adapter',
    });
  });
});
