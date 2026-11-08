import { useAuth } from '@/auth/AuthContext';
import { getMobileEndpointForRealm } from '@/config/env';
import { useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import { subscribeAndroidPushAvailability } from './androidPushAvailability';
import Notifications from './nativeNotifications';
import { useEffect } from 'react';
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
  useEffect(() => {
    const native = Native;
    if (!native) return;
    let cancelled = false;
    let refreshing = false;
    let requested = false;
    const update = async () => {
      if (cancelled) return;
      if (refreshing) { requested = true; return; }
      refreshing = true;
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
        await native.setTaskIdentity?.(api.userId);
        // Task notifications must still work when the chat service is unavailable.
        let actor = ''; let chatBase = '';
        let chatTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const chat = await Promise.race([
            (async () => ({ actor: await api.client.me(), base: await api.endpoint() }))(),
            new Promise<never>((_, reject) => { chatTimeout = setTimeout(() => reject(new Error('CHAT_TIMEOUT')), 8_000); }),
          ]);
          actor = chat.actor; chatBase = chat.base;
        } catch { /* Independent service. */ }
        finally { clearTimeout(chatTimeout); }
        if (cancelled || !api.current()) return;
        await native.setIdentity(actor);
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
    return () => { cancelled = true; state.remove(); refresh.remove(); prefs(); availability(); background(); void native.stop(); void native.setIdentity(''); void native.setTaskIdentity?.(''); };
  }, [api, auth.getAccessToken, selfHostedRelay, t, i18n.language]);
  return null;
}
