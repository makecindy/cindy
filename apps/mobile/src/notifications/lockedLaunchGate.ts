import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { isCredentialStoreReadable } from '@/auth/deviceId';
import Notifications from './nativeNotifications';
import { handleNotificationActionResponse } from './notificationActionRunner';

/**
 * The app is starting without being in front. Before alerts had buttons it was
 * only ever started by the person opening it; a button pressed on a locked
 * phone or on the Watch now starts it unseen. iOS also reports a not-yet-active
 * state early in an ordinary launch, so this is only the reason to check the
 * Keychain, never proof of a locked phone.
 */
function startingUnseen(): boolean {
  return Platform.OS === 'ios' && AppState.currentState !== 'active';
}

/**
 * Holds the signed-in tree while the app was launched unseen on a locked phone. There the Keychain refuses most reads, and the startup code
 * was written for a phone in someone's hand: an unreadable device id or login
 * would look like a fresh install or a signed-out account. Nothing is read,
 * refreshed or cleared until the person opens the app; a button pressed in the
 * meantime is reported as not delivered instead of being attempted.
 *
 * On an unlocked phone the check is one Keychain read and the tree mounts at
 * once, whether the launch was ordinary or in the background.
 */
export function useLockedLaunchGate(): boolean {
  const [ready, setReady] = useState(() => !startingUnseen());
  useEffect(() => {
    if (ready) return;
    let open = false;
    let listening: { remove(): void } | undefined;
    const pass = () => { if (!open) { open = true; listening?.remove(); setReady(true); } };
    const appState = AppState.addEventListener('change', next => { if (next === 'active') pass(); });
    void isCredentialStoreReadable().then(readable => {
      if (open) return;
      // In front by now (the event may have fired before this effect ran): someone is using the phone.
      if (readable || AppState.currentState === 'active') { pass(); return; }
      const undelivered = (response: unknown) => { handleNotificationActionResponse(response, { canRun: false }); };
      listening = Notifications.addNotificationResponseReceivedListener(undelivered);
      void Notifications.getLastNotificationResponseAsync()
        .then(response => { if (response && !open) undelivered(response); })
        .catch(() => undefined);
    });
    return () => { open = true; listening?.remove(); appState.remove(); };
  }, [ready]);
  return ready;
}
