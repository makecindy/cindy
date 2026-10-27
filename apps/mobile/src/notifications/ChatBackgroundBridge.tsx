import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useChatClient } from '@/chat/useChatServer';
import { ChatNotificationsNative as Native, readChatBackgroundEnabled, subscribeChatBackground } from './chatBackground';
import { readPushEnabled, readPushPreviewEnabled, subscribePushPreferences } from './pushNotifications';

/** The existing auth owner rotates tokens; Android receives only a current in-memory copy. */
export function ChatBackgroundBridge() {
  const api = useChatClient();
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
        if (!api.enabled) { await native.setIdentity(''); await native.stop(); return; }
        const [enabled, preview] = await Promise.all([readPushEnabled(), readPushPreviewEnabled()]);
        if (cancelled || !api.current()) return;
        await native.setPreview(preview);
        if (!enabled) { await native.setIdentity(''); await native.stop(); return; }
        const actor = await api.client.me();
        if (cancelled || !api.current()) return;
        await native.setIdentity(actor);
        if (!(await readChatBackgroundEnabled())) { await native.stop(); return; }
        const [base, token] = await Promise.all([api.endpoint(), api.token()]);
        if (cancelled || !api.current() || !token) return;
        await native.configure(api.owner, actor, base, token,
          t('settings.notifications.backgroundActive'), t('settings.notifications.backgroundStop'), preview, i18n.language);
      } catch { /* Foreground and the service's next token refresh retry transient failures. */ }
      finally {
        refreshing = false;
        if (requested) { requested = false; void update(); }
      }
    };
    const state = AppState.addEventListener('change', value => { if (value === 'active') void update(); });
    const refresh = native.addListener('refreshRequested', () => { void update(); });
    const prefs = subscribePushPreferences(signedOut => {
      if (signedOut) { cancelled = true; void native.setIdentity(''); void native.stop(); }
      else void update();
    });
    const background = subscribeChatBackground(() => { void update(); });
    void update();
    return () => { cancelled = true; state.remove(); refresh.remove(); prefs(); background(); void native.stop(); void native.setIdentity(''); };
  }, [api, t, i18n.language]);
  return null;
}
