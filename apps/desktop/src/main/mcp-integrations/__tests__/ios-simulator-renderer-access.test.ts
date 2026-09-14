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

  it('retains authorized Viewer sessions without restoring control from a route report', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(21);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));

    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');

    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toEqual({ sessionId: 'session-b', generation: 2 });

    expect(registry.syncForSessionChange(main.target, 'session-a')).toBe(1);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toBeNull();

    expect(registry.syncForSessionChange(main.target, 'session-b')).toBe(0);
    expect(registry.accessSnapshot(main.target)).toBeNull();
  });

  it('restores the previous active session when a new focus command cannot be delivered', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(22);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    expect(registry.grantAndFocus('session-a')).toBe(true);
    main.send.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });

    expect(registry.grantAndFocus('session-b')).toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(false);
    expect(registry.accessSnapshot(main.target)?.sessionId).toBe('session-a');
  });

  it('does not restore a retained grant when the Host resolver is unavailable', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(221);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    expect(registry.grantAndFocus('session-a')).toBe(true);
    expect(registry.grantAndFocus('session-b')).toBe(true);

    registry.configureResolver(null);

    expect(registry.syncForSessionChange(main.target, 'session-a')).toBe(1);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toBeNull();
  });

  it('keeps the existing same-session grant when a repeated focus command cannot be delivered', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(23);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    expect(registry.grantAndFocus('session-a')).toBe(true);
    const previous = registry.accessSnapshot(main.target);
    main.send.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });

    expect(registry.grantAndFocus('session-a')).toBe(false);
    expect(registry.viewerAccessSnapshot(main.target, 'session-a')).toEqual(previous);
    expect(registry.accessSnapshot(main.target)).toEqual(previous);
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
    expect(revoked).not.toHaveBeenCalled();

    registry.clear();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'session-a', target: main.target }),
        expect.objectContaining({ sessionId: 'session-a', target: sidebar.target }),
        expect.objectContaining({ sessionId: 'session-b', target: main.target }),
        expect.objectContaining({ sessionId: 'session-b', target: sidebar.target }),
      ]),
    );
    expect(revoked.mock.calls[0]?.[0]).toHaveLength(4);
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

  it('inherits every retained Viewer session but only the current active grant', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(55);
    const sidebar = fakeWebContents(56);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');

    expect(registry.inheritAccess(main.target, sidebar.target)).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-b')).toBe(true);
    expect(registry.accessSnapshot(sidebar.target)?.sessionId).toBe('session-b');
  });

  it('refreshes a cached hidden sidebar from the current Main grant before reuse', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(551);
    const sidebar = fakeWebContents(552);
    let sidebarVisible = true;
    registry.configureResolver((preferred) => {
      if (!sidebarVisible && preferred === sidebar.target) return null;
      return {
        grantTargets: sidebarVisible ? [main.target, sidebar.target] : [main.target],
        focusTarget: sidebarVisible ? sidebar.target : main.target,
      };
    });
    registry.grantAndFocus('session-a');

    sidebarVisible = false;
    registry.grantAndFocus('session-b');
    expect(registry.accessSnapshot(main.target)?.sessionId).toBe('session-b');
    expect(registry.accessSnapshot(sidebar.target)?.sessionId).toBe('session-a');

    expect(registry.syncForSessionChange(sidebar.target, null)).toBe(1);
    expect(registry.accessSnapshot(main.target)?.sessionId).toBe('session-b');
    expect(registry.accessSnapshot(sidebar.target)).toBeNull();
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);

    sidebarVisible = true;
    expect(registry.inheritAccess(main.target, sidebar.target)).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-b')).toBe(true);
    expect(registry.accessSnapshot(sidebar.target)?.sessionId).toBe('session-b');
  });

  it('removes the inherited active grant when its session is revoked', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(57);
    const sidebar = fakeWebContents(58);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');
    expect(registry.inheritAccess(main.target, sidebar.target)).toBe(true);

    registry.revokeSession('session-b');

    expect(registry.accessSnapshot(main.target)).toBeNull();
    expect(registry.accessSnapshot(sidebar.target)).toBeNull();
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
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

  it('does not revoke a Viewer intent transferred to a replacement WebContents with the same id', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const original = fakeWebContents(62);
    const replacement = fakeWebContents(62);
    const revoked = vi.fn();
    let current = original.target;
    registry.configureResolver(() => ({ grantTargets: [current], focusTarget: current }));
    registry.configureRevocationObserver(revoked);
    registry.grantAndFocus('session-a');
    revoked.mockClear();

    current = replacement.target;
    expect(registry.grantAndFocus('session-a')).toBe(true);

    expect(registry.hasAccess(original.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(replacement.target, 'session-a')).toBe(true);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('revokes sessions that are not retained when a WebContents id is reused', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const original = fakeWebContents(63);
    const replacement = fakeWebContents(63);
    const revoked = vi.fn();
    let current = original.target;
    registry.configureResolver(() => ({ grantTargets: [current], focusTarget: current }));
    registry.configureRevocationObserver(revoked);
    registry.grantAndFocus('session-a');
    revoked.mockClear();

    current = replacement.target;
    expect(registry.grantAndFocus('session-b')).toBe(true);

    expect(revoked).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: 'session-a', target: original.target }),
    ]);
    expect(registry.hasAccess(replacement.target, 'session-b')).toBe(true);
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

  it('does not treat retained Viewer access as an active mutation grant', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(82);
    const confirm = vi.fn(async () => false);
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');
    registry.configureConfirmation(confirm);

    await expect(registry.requestAccess('session-a', main.target)).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(main.target, 'session-a');
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)?.sessionId).toBe('session-b');
  });

  it('uses Main-owned confirmation for Agent-control elevation and coalesces exact requests', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(85);
    const sidebar = fakeWebContents(87);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.grantAndFocus('session-a');
    registry.configureAgentControlConfirmation(confirm);

    const first = registry.requestAgentControlElevation('session-a', 'instance-a', main.target);
    const second = registry.requestAgentControlElevation('session-a', 'instance-a', sidebar.target);
    await expect(
      registry.requestAgentControlElevation('session-a', 'instance-b', main.target),
    ).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(main.target, 'session-a', 'instance-a');

    deferred.resolve?.(true);
    const [mainApproval, sidebarApproval] = await Promise.all([first, second]);
    expect(mainApproval).not.toBeNull();
    expect(sidebarApproval).not.toBeNull();
    expect(registry.isAgentControlApprovalCurrent(main.target, mainApproval!)).toBe(true);
    expect(registry.isAgentControlApprovalCurrent(sidebar.target, sidebarApproval!)).toBe(true);
  });

  it('invalidates Agent-control confirmation when the exact task grant changes', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(86);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.configureAgentControlConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAgentControlElevation('session-a', 'instance-a', main.target);
    registry.grantAndFocus('session-b');
    deferred.resolve?.(true);

    await expect(pending).resolves.toBeNull();
  });

  it('invalidates Agent-control confirmation when session focus deactivates mutations', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(89);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.configureAgentControlConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAgentControlElevation('session-a', 'instance-a', main.target);
    expect(registry.syncForSessionChange(main.target, 'session-b')).toBe(1);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBeNull();
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toBeNull();
  });

  it('lets a direct revocation invalidate an older pending elevation', async () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(88);
    const deferred: { resolve?: (confirmed: boolean) => void } = {};
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.grantAndFocus('session-a');
    registry.configureAgentControlConfirmation(
      () =>
        new Promise<boolean>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = registry.requestAgentControlElevation('session-a', 'instance-a', main.target);
    registry.invalidateAgentControlElevation('session-a', 'instance-a');
    deferred.resolve?.(true);

    await expect(pending).resolves.toBeNull();
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
    expect(registry.syncForSessionChange(main.target, 'session-b')).toBe(0);
    deferred.resolve?.(true);

    await expect(pending).resolves.toBe(false);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(false);
  });

  it('keeps an inherited family paused until an authoritative focus grant returns', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(101);
    const sidebar = fakeWebContents(102);
    const revoked = vi.fn();
    registry.configureResolver(() => ({
      grantTargets: [main.target, sidebar.target],
      focusTarget: sidebar.target,
    }));
    registry.configureRevocationObserver(revoked);
    registry.grantAndFocus('session-a');
    revoked.mockClear();

    expect(registry.syncForSessionChange(main.target, 'session-b')).toBe(2);
    expect(registry.hasAccess(main.target, 'session-a')).toBe(true);
    expect(registry.hasAccess(sidebar.target, 'session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toBeNull();
    expect(registry.accessSnapshot(sidebar.target)).toBeNull();
    expect(revoked).not.toHaveBeenCalled();

    expect(registry.syncForSessionChange(sidebar.target, 'session-a')).toBe(0);
    expect(registry.accessSnapshot(main.target)).toBeNull();
    expect(registry.accessSnapshot(sidebar.target)).toBeNull();

    expect(registry.grantAndFocus('session-a')).toBe(true);
    expect(registry.accessSnapshot(main.target)).toEqual({
      sessionId: 'session-a',
      generation: 2,
    });
    expect(registry.accessSnapshot(sidebar.target)).toEqual({
      sessionId: 'session-a',
      generation: 2,
    });
  });

  it('revokes only the removed session while keeping other Viewer grants usable', () => {
    const registry = new IOSSimulatorRendererAccessRegistry();
    const main = fakeWebContents(103);
    const revoked = vi.fn();
    registry.configureResolver(() => ({ grantTargets: [main.target], focusTarget: main.target }));
    registry.configureRevocationObserver(revoked);
    registry.grantAndFocus('session-a');
    registry.grantAndFocus('session-b');
    revoked.mockClear();

    registry.revokeSession('session-a');

    expect(registry.hasAccess(main.target, 'session-a')).toBe(false);
    expect(registry.hasAccess(main.target, 'session-b')).toBe(true);
    expect(registry.accessSnapshot(main.target)?.sessionId).toBe('session-b');
    expect(revoked).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: 'session-a', target: main.target }),
    ]);
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
