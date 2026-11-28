import type { Session, WebContents } from 'electron';

import { isGhostLocalServiceRequest } from '../../shared/ghostLocalServicePage.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { onAppSessionInvalidated } from '../appSessionState.js';

const guardedSessions = new WeakSet<Session>();
const liveGuests = new Map<number, {
  instanceId: string;
  session: Session;
  isCurrent(ghost: InstalledGhost | undefined): boolean;
  revoke(): void;
}>();

export function guardGhostLocalServiceSession(session: Session, origin: string): void {
  if (guardedSessions.has(session)) return;
  session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  // HTTP/WebSocket requests are filtered before dispatch. Other Chromium
  // transports must also stay on loopback; any proxy traffic can only reach
  // the already-approved service, and never inherits the system proxy.
  const authority = new URL(origin).host;
  const proxyReady = session.setProxy({
    mode: 'fixed_servers',
    proxyRules: origin,
    proxyBypassRules: `<-loopback>;http://${authority};ws://${authority}`,
  }).then(() => true, () => false);
  session.webRequest.onBeforeRequest((details, reply) => {
    if (!isGhostLocalServiceRequest(origin, details.url, details.resourceType === 'webSocket')) {
      reply({ cancel: true });
      return;
    }
    void proxyReady.then((ready) => {
      const active = details.webContentsId !== undefined && liveGuests.get(details.webContentsId)?.session === session;
      reply({ cancel: !ready || !active });
    });
  });
  session.webRequest.onHeadersReceived((details, reply) => {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
      reply({});
      return;
    }
    // Append a separate policy so the service's own CSP remains in effect.
    const headers = { ...details.responseHeaders };
    const csp = Object.keys(headers).find(key => key.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
    headers[csp] = [...(headers[csp] ?? []), `connect-src ${origin} ws://${authority}; worker-src 'none'`];
    const dnsPrefetch = Object.keys(headers).find(key => key.toLowerCase() === 'x-dns-prefetch-control') ?? 'X-DNS-Prefetch-Control';
    headers[dnsPrefetch] = ['off'];
    reply({ responseHeaders: headers });
  });
  guardedSessions.add(session);
}

export function attachGhostLocalServiceGuest(
  guest: WebContents,
  instanceId: string,
  origin: string,
  isCurrent: (ghost: InstalledGhost | undefined) => boolean,
): void {
  const id = guest.id;
  const revoke = () => {
    liveGuests.delete(id);
    if (!guest.isDestroyed()) guest.close();
  };
  liveGuests.set(id, { instanceId, session: guest.session, isCurrent, revoke });
  const unsubscribe = onAppSessionInvalidated(revoke);
  guest.once('destroyed', () => {
    liveGuests.delete(id);
    unsubscribe();
  });
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event: Electron.Event & { url: string }) => {
    if (!liveGuests.has(id) || !isGhostLocalServiceRequest(origin, event.url)) event.preventDefault();
  };
  guest.on('will-frame-navigate', guard);
  guest.on('will-redirect', guard);
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

/** Close a live guest when the owning plugin is stopped, replaced or removed. */
export function reconcileGhostLocalServiceGuests(ghosts: readonly InstalledGhost[]): void {
  if (liveGuests.size === 0) return;
  const current = new Map(ghosts.map(ghost => [installedGhostStoragePart(ghost), ghost]));
  for (const binding of liveGuests.values()) {
    if (!binding.isCurrent(current.get(binding.instanceId))) binding.revoke();
  }
}
