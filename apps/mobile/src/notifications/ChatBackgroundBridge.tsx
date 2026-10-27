import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useChatClient } from '@/chat/useChatServer';
import Notifications from './nativeNotifications';
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
    let revision = 0;
    const update = async () => {
      if (cancelled) return;
      const captured = ++revision;
      if (refreshing) { requested = true; return; }
      const current = () => !cancelled && captured === revision && api.current();
      refreshing = true;
      try {
        if (!api.enabled) { await native.setIdentity(''); await native.stop(); return; }
        const [enabled, preview] = await Promise.all([readPushEnabled(), readPushPreviewEnabled()]);
        if (!current()) return;
        await native.setPreview(preview);
        if (!enabled) { await native.setIdentity(''); await native.stop(); return; }
        // A saved preference is not proof of system permission. Settings owns
        // prompting; startup/token refresh must never prompt or start a service
        // whose ongoing notification the user has disabled.
        const permission = await Notifications.getPermissionsAsync();
        if (!current()) return;
        if (permission.status !== 'granted') { await native.setIdentity(''); await native.stop(); return; }
        const actor = await api.client.me();
        if (!current()) return;
        await native.setIdentity(actor);
        const background = await readChatBackgroundEnabled();
        if (!current()) return;
        if (!background) { await native.stop(); return; }
        const [base, token] = await Promise.all([api.endpoint(), api.token()]);
        // Preference updates supersede in-flight credential reads, even when
        // they belong to the same account. Never restart after an opt-out.
        if (!current() || !token) return;
        await native.configure(api.owner, actor, base, token,
          t('settings.notifications.backgroundActive'), t('settings.notifications.backgroundStop'), preview, i18n.language);
      } catch { /* Foreground and the service's next token refresh retry transient failures. */ }
      finally {
        refreshing = false;
        if (requested) { requested = false; void update(); }
      }
    };
    const state = AppState.addEventListener('change', value => { if (value === 'active') void update(); });
    // Android can become active before its window has focus. The native service
    // requires a focused activity to start; retry on the actual focus event.
    const focus = AppState.addEventListener('focus', () => { void update(); });
    const refresh = native.addListener('refreshRequested', () => { void update(); });
    const prefs = subscribePushPreferences(signedOut => {
      if (signedOut) { cancelled = true; void native.setIdentity(''); void native.stop(); }
      else void update();
    });
    const background = subscribeChatBackground(() => { void update(); });
    void update();
    return () => { cancelled = true; state.remove(); focus.remove(); refresh.remove(); prefs(); background(); void native.stop(); void native.setIdentity(''); };
  }, [api, t, i18n.language]);
  return null;
}
