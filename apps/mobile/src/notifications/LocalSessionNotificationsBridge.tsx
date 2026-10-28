import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { isScopedPeer, MOBILE_NOTIFICATION_CHANNEL, MOBILE_NOTIFICATION_CAPABILITY } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { deviceLinkWsUrl, getActiveMobileSessionRealm } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import Native from '../../modules/cindy-chat-notifications/src';
import { readChatBackgroundEnabled, subscribeChatBackground } from './chatBackground';
import { readPushEnabled, subscribePushPreferences, usesLocalSessionNotifications } from './pushNotifications';
import { subscribeLocalSessionFrames } from './localSessionFrames';

/** Native background and JS foreground share live IDs, never the history/import stream.
 * FCM-capable installations keep their existing delivery path and do not subscribe here.
 */
export function LocalSessionNotificationsBridge() {
  const auth = useAuth();
  const link = useDeviceLink();
  const [revision, setRevision] = useState(0);
  const credentialRevision = useRef(0);
  useEffect(() => {
    const prefs = subscribePushPreferences(signedOut => {
      if (signedOut || !usesLocalSessionNotifications()) void Native?.clearSessionRelay?.();
      credentialRevision.current++;
      setRevision(value => value + 1);
    });
    const background = subscribeChatBackground(() => { credentialRevision.current++; setRevision(value => value + 1); });
    const refresh = Native?.addListener('refreshRequested', () => setRevision(value => value + 1));
    return () => { prefs(); background(); refresh?.remove(); };
  }, []);
  const owner = `${auth.user?.id ?? ''}:${auth.accountGeneration}:${getActiveMobileSessionRealm()}`;
  const rosterCache = useRef<{ key: string; targets: string[] } | null>(null);
  const [prepared, setPrepared] = useState<{ owner: string; targets: string[] } | null>(null);
  useEffect(() => {
    if (!Native?.configureSessionRelay) return;
    const native = Native;
    let disposed = false;
    const authOwner = getMobileAuthOwner();
    const captured = credentialRevision.current;
    const current = () => !disposed && captured === credentialRevision.current
      && isMobileAuthOwnerCurrent(authOwner) && usesLocalSessionNotifications();
    void (async () => {
      try {
        if (!auth.isAuthenticated || !auth.user || !auth.deviceId || !usesLocalSessionNotifications()
          || !await readPushEnabled() || !await readChatBackgroundEnabled()) {
          if (!disposed) { setPrepared(null); await native.clearSessionRelay?.(); }
          return;
        }
        // Roster refresh is driven by connection/presence changes, not the native
        // credential-refresh tick. Background delivery uses relay presence frames.
        const key = JSON.stringify([owner, link.connectionEpoch, link.presenceVersion]);
        const targets = rosterCache.current?.key === key ? rosterCache.current.targets
          : (await link.readDeviceList()).devices.filter(device => device.deviceId !== auth.deviceId && device.remoteControlEnabled
            && !isScopedPeer(device.deviceId)).map(device => device.deviceId).sort().slice(0, 100);
        const token = await auth.getAccessToken();
        if (!current() || !token) return;
        rosterCache.current = { key, targets };
        await native.configureSessionRelay!(owner, auth.user.id, auth.deviceId, deviceLinkWsUrl(), token, JSON.stringify(targets));
        if (!current()) return;
        setPrepared(previous => previous?.owner === owner && JSON.stringify(previous.targets) === JSON.stringify(targets)
          ? previous : { owner, targets });
      } catch { /* Transport/auth failures never enter logs with token/preview data. */ }
    })();
    return () => { disposed = true; };
  }, [owner, auth.deviceId, auth.isAuthenticated, link.status, link.connectionEpoch, link.presenceVersion, revision]);

  useEffect(() => () => { void Native?.clearSessionRelay?.(); }, []);
  return prepared?.owner === owner && usesLocalSessionNotifications() && link.status === 'online'
    ? prepared.targets.map(device => <LocalSessionNotificationLease key={`${owner}:${device}`} owner={owner} device={device} />) : null;
}

/** One peer owns one lease; a roster change cannot reset unrelated computers. */
function LocalSessionNotificationLease({ owner, device }: { owner: string; device: string }) {
  const link = useDeviceLink();
  useEffect(() => {
    if (!Native?.receiveSessionNotification || !link.openNotificationLink) return;
    const native = Native;
    const authOwner = getMobileAuthOwner();
    let disposed = false;
    const nonce = randomUUID();
    const topic = `notifications:${nonce}`;
    const current = () => !disposed && isMobileAuthOwnerCurrent(authOwner) && usesLocalSessionNotifications();
    const off = subscribeLocalSessionFrames(frame => {
      if (!current() || frame.kind !== 'push' || frame.src !== device || frame.sharedTask || frame.providerShare) return;
      const push = frame.payload as { channel?: string; payload?: { subscriptionId?: string } } | undefined;
      if (push?.channel !== MOBILE_NOTIFICATION_CHANNEL || push.payload?.subscriptionId !== nonce) return;
      void native.receiveSessionNotification?.(owner, device, JSON.stringify(push.payload)).catch(() => undefined);
    });
    void (async () => {
      const accepted = await link.openNotificationLink!(device);
      if (!current() || !accepted.capabilities?.includes(MOBILE_NOTIFICATION_CAPABILITY)) return;
      await link.subscribe(nonce, device, [topic]);
    })().catch(() => undefined);
    return () => {
      disposed = true; off();
      // Release even if subscribe was still awaiting an ACK at cleanup.
      void link.unsubscribe(nonce, device, [topic]).catch(() => undefined);
    };
  }, [owner, device, link.status, link.connectionEpoch]);
  return null;
}
