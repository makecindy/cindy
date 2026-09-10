import { describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopLease } from '@cindy/device-link';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';

function fixture() {
  const sessions = new Map<string, string>();
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    authenticationSession: (peer) => sessions.get(peer) ?? null,
    capabilities: vi.fn(async () => ({
      version: 1 as const,
      enabled: true,
      canControl: true,
      platform: 'darwin',
      displays: [{ id: 'display', name: 'Private display', width: 1920, height: 1080 }],
    })),
    frame: vi.fn(async () => 'private-frame'),
    startInput: vi.fn(async () => {}),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    changed: vi.fn(),
    offer: vi.fn(async () => 'answer'),
    clipboard: vi.fn(async () => 'private clipboard'),
  };
  const controller = new RemoteDesktopController(deps);
  const start = (peer = 'phone', options = {}) =>
    controller.request(peer, {
      op: 'start',
      displayId: 'display',
      ...options,
    }) as Promise<RemoteDesktopLease>;
  return { sessions, deps, controller, start };
}

describe('remote desktop credential-session boundary', () => {
  it('does not let valid credentials override the host access switch', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    h.deps.authorized = () => false;
    await expect(h.controller.request('phone', { op: 'capabilities' })).rejects.toThrow(
      'DESKTOP_DISABLED',
    );
    expect(h.deps.capabilities).not.toHaveBeenCalled();
  });

  it('requires host authentication before reading displays or creating a view-only lease', async () => {
    const h = fixture();
    await expect(h.controller.request('phone', { op: 'capabilities' })).rejects.toThrow(
      'DESKTOP_AUTHENTICATION_REQUIRED',
    );
    await expect(h.start()).rejects.toThrow('DESKTOP_AUTHENTICATION_REQUIRED');
    expect(h.deps.capabilities).not.toHaveBeenCalled();
    expect(h.controller.state).toBeNull();
    expect(h.deps.frame).not.toHaveBeenCalled();
    expect(h.deps.offer).not.toHaveBeenCalled();
  });

  it('ignores controller-supplied claims and cannot reuse another phone authentication', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified-session');
    await expect(
      h.start('other', { verified: true, authenticationSession: 'verified-session' }),
    ).rejects.toThrow('DESKTOP_AUTHENTICATION_REQUIRED');
    const lease = await h.start();
    await expect(
      h.controller.request('other', { op: 'frame', lease: lease.lease }),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.frame).not.toHaveBeenCalled();
    expect(h.controller.hasLease(lease.lease)).toBe(true);
  });

  it('rejects a late start when authentication changes during display enumeration', async () => {
    const h = fixture();
    h.sessions.set('phone', 'first');
    const caps = await h.deps.capabilities();
    let finish!: (value: typeof caps) => void;
    h.deps.capabilities = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.start();
    h.sessions.set('phone', 'replacement');
    finish(caps);
    await expect(pending).rejects.toThrow('DESKTOP_AUTHENTICATION_REQUIRED');
    expect(h.controller.state).toBeNull();
  });

  it('does not return a frame captured before credential revocation', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const lease = await h.start();
    let finish!: (frame: string) => void;
    h.deps.frame = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.controller.request('phone', { op: 'frame', lease: lease.lease });
    h.sessions.delete('phone');
    finish('must-not-leak');
    await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.controller.state).toBeNull();
    expect(h.deps.stopVideo).toHaveBeenCalled();
  });

  it.each(['input', 'clipboard', 'offer', 'heartbeat', 'presentation'])(
    'does not let replacement authentication revive an old lease (%s)',
    async (op) => {
      const h = fixture();
      h.sessions.set('phone', 'first');
      const lease = await h.start();
      await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
      h.sessions.set('phone', 'second');
      const request = {
        op,
        lease: lease.lease,
        sequence: 1,
        events: [{ kind: 'release' }],
        action: 'copy',
        sdp: 'offer',
        enabled: true,
      };
      await expect(h.controller.request('phone', request)).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
      expect(h.deps.input).not.toHaveBeenCalled();
      expect(h.deps.clipboard).not.toHaveBeenCalled();
      expect(h.deps.offer).not.toHaveBeenCalled();
    },
  );

  it('checks native authentication for direct DataChannel input and PiP heartbeats', async () => {
    const h = fixture();
    h.sessions.set('phone', 'first');
    const lease = await h.start();
    await h.controller.request('phone', { op: 'control', lease: lease.lease, enabled: true });
    h.sessions.delete('phone');
    expect(() =>
      h.controller.input(lease.lease, 1, [{ kind: 'text', text: 'not-a-password' }]),
    ).toThrow('DESKTOP_LEASE_EXPIRED');
    h.controller.viewHeartbeat(lease.lease);
    expect(h.controller.hasLease(lease.lease)).toBe(false);
    expect(h.deps.input).not.toHaveBeenCalled();
  });

  it('keeps one authentication session across media retry and lease rotation', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const first = await h.start();
    for (const attemptId of ['first', 'retry'])
      await h.controller.request('phone', {
        op: 'offer',
        lease: first.lease,
        sdp: 'offer',
        attemptId,
      });
    const next = await h.start('phone', { resume: true });
    expect(next.lease).not.toBe(first.lease);
    expect(h.controller.hasLease(next.lease)).toBe(true);
  });

  it('does not disconnect an authenticated viewer when another unverified phone takes over', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const first = await h.start();
    await expect(h.start('other', { takeover: true })).rejects.toThrow(
      'DESKTOP_AUTHENTICATION_REQUIRED',
    );
    expect(h.controller.hasLease(first.lease)).toBe(true);
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  });

  it('revokes viewing when the native authentication provider fails', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const lease = await h.start();
    h.deps.authenticationSession = () => {
      throw new Error('native unavailable');
    };
    h.controller.tick();
    expect(h.controller.hasLease(lease.lease)).toBe(false);
    expect(h.deps.stopVideo).toHaveBeenCalled();
  });

  it('does not propagate native credential diagnostics to a remote caller', async () => {
    const h = fixture();
    h.deps.authenticationSession = () => {
      throw new Error('private native diagnostic');
    };
    await expect(h.start()).rejects.toThrow(/^DESKTOP_AUTHENTICATION_REQUIRED$/);
  });

  it('discards display metadata when authentication expires during enumeration', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const caps = await h.deps.capabilities();
    let finish!: (value: typeof caps) => void;
    h.deps.capabilities = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.controller.request('phone', { op: 'capabilities' });
    h.sessions.delete('phone');
    finish(caps);
    await expect(pending).rejects.toThrow('DESKTOP_AUTHENTICATION_REQUIRED');
  });

  it('releases input started concurrently with authentication revocation', async () => {
    const h = fixture();
    h.sessions.set('phone', 'verified');
    const lease = await h.start();
    let finish!: () => void;
    h.deps.startInput = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.controller.request('phone', {
      op: 'control',
      lease: lease.lease,
      enabled: true,
    });
    h.sessions.delete('phone');
    finish();
    await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.stopInput).toHaveBeenCalled();
    expect(h.controller.state).toBeNull();
  });
});
