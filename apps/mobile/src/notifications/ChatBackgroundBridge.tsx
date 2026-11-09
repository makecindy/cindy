import { useAuth } from '@/auth/AuthContext';
import { getMobileEndpointForRealm } from '@/config/env';
import { useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import { subscribeAndroidPushAvailability } from './androidPushAvailability';
import Notifications from './nativeNotifications';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useChatClient } from '@/chat/useChatServer';
import { ChatNotificationsNative as Native, readChatBackgroundEnabled, subscribeChatBackground } from './chatBackground';
import { readPushEnabled, readPushPreviewEnabled, subscribePushPreferences } from './pushNotifications';

/** The existing auth owner rotates tokens; Android receives only a current in-memory copy. */
export function ChatBackgroundBridge() {
  const api = useChatClient();
  const auth = useAuth();
  const selfHostedRelay = useSelfHostedRelay() !== null;
  const { t, i18n } = useTranslation();
  const knownChat = useRef({ owner: '', actor: '', base: '' });
  useEffect(() => {
    const native = Native;
    if (!native) return;
    const sameOwner = knownChat.current.owner === api.owner;
    if (!sameOwner) knownChat.current = { owner: api.owner, actor: '', base: '' };
    let cancelled = false;
    let refreshing = false;
    let requested = false;
    let identityBound = false;
    let refreshGeneration = 0;
    const update = async () => {
      if (cancelled) return;
      const generation = ++refreshGeneration;
      if (refreshing) { requested = true; return; }
      refreshing = true;
      let lateChat: Promise<{ actor: string; base: string }> | undefined;
      try {
        if (!api.enabled) { await native.setIdentity(''); await native.setTaskIdentity?.(''); await native.stop(); return; }
        const [enabled, preview] = await Promise.all([readPushEnabled(), readPushPreviewEnabled()]);
        if (cancelled || !api.current()) return;
        if (!enabled || (await Notifications.getPermissionsAsync()).status !== 'granted') {
          if (cancelled || !api.current()) return;
          await native.setIdentity(''); await native.setTaskIdentity?.(''); await native.stop(); return;
        }
        if (cancelled || !api.current()) return;
        await native.setPreview(preview);
        if (cancelled || !api.current()) return;
        if (!identityBound) {
          if (native.setOwner) await native.setOwner(`${api.userId}:${api.realm}`);
          else if (!sameOwner) await native.setIdentity('');
          identityBound = true;
        }
        if (cancelled || !api.current()) return;
        await native.setTaskIdentity?.(api.userId);
        // Task notifications must still work when the chat service is unavailable.
        let actor = knownChat.current.actor; let chatBase = knownChat.current.base;
        let chatTimeout: ReturnType<typeof setTimeout> | undefined;
        const chatRequest = (async () => ({ actor: await api.client.me(), base: await api.endpoint() }))();
        try {
          const chat = await Promise.race([
            chatRequest,
            new Promise<never>((_, reject) => { chatTimeout = setTimeout(() => {
              lateChat = chatRequest;
              reject(new Error('CHAT_TIMEOUT'));
            }, 8_000); }),
          ]);
          if (cancelled || !api.current()) return;
          actor = chat.actor; chatBase = chat.base;
          knownChat.current = { owner: api.owner, actor, base: chatBase };
        } catch { /* Independent service. */ }
        finally { clearTimeout(chatTimeout); }
        if (cancelled || !api.current()) return;
        if (actor) await native.setIdentity(actor);
        const backgroundEnabled = await readChatBackgroundEnabled();
        if (cancelled || !api.current()) return;
        if (!backgroundEnabled) { await native.stop(); return; }
        const token = await auth.getAccessToken();
        if (cancelled || !api.current() || !token) return;
        const title = t('settings.notifications.backgroundActive');
        const stopLabel = t('settings.notifications.backgroundStop');
        if (native.configureNotifications) {
          const taskBase = selfHostedRelay ? '' : getMobileEndpointForRealm(api.realm, 'deviceLinkApiBaseUrl');
          if (!chatBase && !taskBase) { await native.stop(); return; }
          await native.configureNotifications({ owner: api.owner, actor, chatBase, user: api.userId, taskBase,
            token, title, stopLabel, preview, language: i18n.language });
        } else if (actor && chatBase) {
          await native.configure(api.owner, actor, chatBase, token, title, stopLabel, preview, i18n.language);
        }
      } catch { /* Foreground and the service's next token refresh retry transient failures. */ }
      finally {
        // Finish task/service configuration first so it cannot overwrite a late FCM identity.
        // Off/FCM-only modes have no service refresh loop to recover this successful lookup.
        if (lateChat) void lateChat.then(async chat => {
          const current = () => !cancelled && api.current() && generation === refreshGeneration;
          if (!current()) return;
          const enabled = await readPushEnabled();
          const permission = await Notifications.getPermissionsAsync();
          if (!current() || !enabled || permission.status !== 'granted') return;
          knownChat.current = { owner: api.owner, actor: chat.actor, base: chat.base };
          await native.setIdentity(chat.actor);
        }).catch(() => { /* A failed lookup leaves the last verified identity intact. */ });
        refreshing = false;
        if (requested) { requested = false; void update(); }
      }
    };
    const state = AppState.addEventListener('change', value => { if (value === 'active') void update(); });
    const refresh = native.addListener('refreshRequested', () => { void update(); });
    const prefs = subscribePushPreferences(signedOut => {
      if (signedOut) { cancelled = true; void native.setIdentity(''); void native.setTaskIdentity?.(''); void native.stop(); }
      else void update();
    });
    const availability = subscribeAndroidPushAvailability(() => { void update(); });
    const background = subscribeChatBackground(() => { void update(); });
    void update();
    // Account changes are fenced by setOwner; retranslation/token refresh must not erase identity.
    return () => { cancelled = true; state.remove(); refresh.remove(); prefs(); availability(); background(); void native.stop(); };
  }, [api, auth.getAccessToken, selfHostedRelay, t, i18n.language]);
  return null;
}
