import { describe, expect, it, vi } from 'vitest';

import type { IOSSimulatorPublicRouteStatus } from '../../../shared/iosSimulatorIpc';
import {
  IOSSimulatorRendererAccessRegistry,
  type IOSSimulatorRendererWebContents,
} from '../ios-simulator-renderer-access';

function fakeWebContents(id: number) {
  let destroyed = false;
  let destroyedListener: (() => void) | null = null;
  const target: IOSSimulatorRendererWebContents = {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn((_event: 'destroyed', listener: () => void) => {
      destroyedListener = listener;
    }),
  };
  return {
    target,
    send: target.send as ReturnType<typeof vi.fn>,
    destroy: () => {
      destroyed = true;
      destroyedListener?.();
    },
  };
}

const routeStatus: IOSSimulatorPublicRouteStatus = {
  sessionId: 'session-a',
  instanceId: 'instance-a',
  generation: 1,
  updatedAt: '2026-08-08T00:00:00.000Z',
  stream: {
    adapter: 'native-sidecar',
    encoding: 'h264',
    state: 'active',
    reasonCode: 'native-active',
  },
  input: {
    adapter: 'native-sidecar',
    state: 'active',
    continuous: true,
    multiTouch: false,
    reasonCode: 'native-active',
  },
};

describe('IOSSimulatorRendererAccessRegistry', () => {
  it('grants an exact Main-owned window family and focuses only the selected host', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(11);
    const sidebar = fakeWebContents(12);
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));

    expect(registry.grantAndFocus('session-a', 'instance-a')).toBe(true);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(false);
    expect(main.send).not.toHaveBeenCalled();
    expect(sidebar.send).toHaveBeenCalledWith('maker:ios-simulator:focus-request', {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      userInitiated: false,
    });
  });

  it('returns only the exact live Main-owned task binding', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(13);
    const replacement = fakeWebContents(13);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));

    expect(registry.accessSnapshot(main.target)).toBeNull();
    expect(registry.grantAndFocus('session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toEqual({ sessionId: 'session-a', generation: 1 });
    expect(registry.accessSnapshot(replacement.target)).toBeNull();
    expect(registry.grantAndFocus('session-b')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toEqual({ sessionId: 'session-b', generation: 2 });

    main.destroy();
    expect(registry.accessSnapshot(main.target)).toBeNull();
  });

  it('replaces the previous session grant instead of trusting a forged route', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(21);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));

    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');

    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(true);
  });

  it('notifies only when an exact renderer actually loses its session grant', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(211);
    const sidebar = fakeWebContents(212);
    const revoked = vi.fn();
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.configureRevocationObserver(revoked);

    registry.grantAndFocus('session-a');
    revoked.mockClear();
    registry.grantAndFocus('session-a');
    expect(revoked).not.toHaveBeenCalled();

    registry.grantAndFocus('session-b');
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'session-a', target: main.target }),
      expect.objectContaining({ sessionId: 'session-a', target: sidebar.target }),
    ]);

    revoked.mockClear();
    registry.clear();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'session-b', target: main.target }),
      expect.objectContaining({ sessionId: 'session-b', target: sidebar.target }),
    ]);
  });

  it('notifies synchronously when a granted renderer is destroyed', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(221);
    const revoked = vi.fn();
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureRevocationObserver(revoked);
    registry.grantAndFocus('session-a');
    revoked.mockClear();

    main.destroy();

    expect(revoked).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: 'session-a', target: main.target }),
    ]);
  });

  it('pushes route status only to exact renderers granted for that session', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const sessionA = fakeWebContents(31);
    const sessionB = fakeWebContents(32);
    registry.configureResolver((preferred) => ({
      grantTargets: preferred ? [preferred] : [],
      focusTarget: preferred ?? null,
    }));
    registry.grantAndFocus('session-a', undefined, sessionA.target);
    registry.grantAndFocus('session-b', undefined, sessionB.target);
    sessionA.send.mockClear();
    sessionB.send.mockClear();

    expect(registry.pushRouteStatus(routeStatus)).toBe(1);
    expect(sessionA.send).toHaveBeenCalledWith('maker:ios-simulator:route-status', routeStatus);
    expect(sessionB.send).not.toHaveBeenCalled();
  });

  it('revokes grants when a window is destroyed or a task is removed', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const first = fakeWebContents(41);
    const second = fakeWebContents(42);
    registry.configureResolver((preferred) => ({
      grantTargets: preferred ? [preferred] : [],
      focusTarget: preferred ?? null,
    }));
    registry.grantAndFocus('session-a', undefined, first.target);
    registry.grantAndFocus('session-a', undefined, second.target);

    first.destroy();
    expect(registry.hasAccess(first.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(second.target, 'session-a')).toBe(true);

    registry.revokeSession('session-a');
    expect(registry.hasAccess(second.target, 'session-a')).toBe(false);
  });

  it('inherits the current Main grant when a detached sidebar is created later', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(51);
    const sidebar = fakeWebContents(52);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');

    expect(registry.inheritAccess(main.target, sidebar.target)).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-b')).toBe(false);
  });

  it('does not let an older sidebar confirmation overwrite a newly inherited Host grant', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(53);
    const sidebar = fakeWebContents(54);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-b');
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', sidebar.target);
    expect(registry.inheritAccess(main.target, sidebar.target)).toBe(true);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-b')).toBe(true);
  });

  it('requires the exact WebContents object even when a numeric id is reused', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const original = fakeWebContents(61);
    const replacement = fakeWebContents(61);
    registry.configureResolver(() => ({
      grantTargets: [original.target],
      focusTarget: original.target,
    }));
    registry.grantAndFocus('session-a');

    expect(registry.hasAccess(original.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(replacement.target, 'session-a')).toBe(false);
  });

  it('grants a confirmed manual request without sending a focus command', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(71);
    const sidebar = fakeWebContents(72);
    const confirm = vi.fn(async () => true);
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.configureConfirmation(confirm);

    await expect(registry.requestAccess('session-a', main.target)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(main.target, 'session-a');
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(main.send).not.toHaveBeenCalled();
    expect(sidebar.send).not.toHaveBeenCalled();
  });

  it('does not grant when native confirmation is cancelled', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(81);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureConfirmation(async () => false);

    await expect(registry.requestAccess('session-a', main.target)).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
  });

  it('invalidates a pending confirmation when the window family switches tasks', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(91);
    const sidebar = fakeWebContents(92);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', sidebar.target);
    expect(registry.revokeForSessionChange(main.target, 'session-b')).toBe(0);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(false);
  });

  it('revokes an entire inherited family when either target switches tasks', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(101);
    const sidebar = fakeWebContents(102);
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.grantAndFocus('session-a');

    expect(registry.revokeForSessionChange(main.target, 'session-b')).toBe(2);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(false);
  });

  it('does not grant after the requesting WebContents is destroyed', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(111);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', main.target);
    main.destroy();
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
  });

  it('does not let an older manual confirmation overwrite a newer Host grant', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(121);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', main.target);
    expect(registry.grantAndFocus('session-b')).toBe(true);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(true);
  });

  it('reports success when a concurrent Host flow grants the same session', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(131);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', main.target);
    expect(registry.grantAndFocus('session-a')).toBe(true);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(true);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
  });

  it.each([
    ['plugin disable', (registry: IOSSimulatorRendererAccessRegistry) => registry.clear()],
    [
      'session removal',
      (registry: IOSSimulatorRendererAccessRegistry) => registry.revokeSession('session-a'),
    ],
  ])('invalidates a pending confirmation after %s', async (_reason, revoke) => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(141);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAccess('session-a', main.target);
    revoke(registry);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
  });
});
