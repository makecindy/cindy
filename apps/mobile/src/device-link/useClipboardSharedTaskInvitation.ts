import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { parseSharedTaskInvitation, sharedTaskInvitationServer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import {
  getPendingSharedTaskInvitationIntent, getSharedTaskInvitationIntentSequence,
  receiveSharedTaskInvitationIntent, subscribeSharedTaskInvitationIntent,
} from './sharedTaskInvitationIntent';

/** Clipboard contents stay in memory. Only a valid link for this service opens admission. */
export function useClipboardSharedTaskInvitation(enabled: boolean, joining: boolean): void {
  const joiningRef = useRef(joining);
  joiningRef.current = joining;
  const seenInvitations = useRef(new Set<string>());
  useEffect(() => {
    const rememberExplicitInvitation = () => {
      const intent = getPendingSharedTaskInvitationIntent();
      if (intent?.source === 'link' && intent.server === sharedTaskInvitationServer(DEVICE_LINK_API_BASE_URL)) {
        seenInvitations.current.add(intent.invitation);
      }
    };
    // Observe even before login enables clipboard reads, and before admission clears
    // the pending intent. Explicit links remain usable; only clipboard offers dedupe.
    const stopWatching = subscribeSharedTaskInvitationIntent(rememberExplicitInvitation);
    rememberExplicitInvitation();
    return stopWatching;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reading = false;
    let started = false;
    let background = false;
    let activation = 0;
    let deferredOffer: (() => void) | null = null;
    const check = async () => {
      if (reading || joiningRef.current || getPendingSharedTaskInvitationIntent()) return;
      const owner = getMobileAuthOwner();
      if (owner.switching || !owner.accountKey) return;
      reading = true;
      const captured = activation;
      const sequence = getSharedTaskInvitationIntentSequence();
      try {
        const text = await Clipboard.getStringAsync();
        if (disposed) return;
        // Bare codes could be unrelated clipboard data; automatic detection accepts links only.
        if (!/https?:\/\//.test(text)) return;
        const parsed = parseSharedTaskInvitation(text, DEVICE_LINK_API_BASE_URL);
        if (!parsed.ok || seenInvitations.current.has(parsed.invitation)) return;
        const offer = () => {
          if (disposed || captured !== activation || joiningRef.current || !isMobileAuthOwnerCurrent(owner)
              || sequence !== getSharedTaskInvitationIntentSequence() || getPendingSharedTaskInvitationIntent()) {
            return;
          }
          // The iOS paste permission sheet can resolve the read while the app is inactive.
          // Keep that result until focus returns instead of reading the clipboard again.
          if (AppState.currentState !== 'active') { deferredOffer = offer; return; }
          const url = 'cindy://shared-session?invitation=' + encodeURIComponent(parsed.invitation)
            + '&server=' + encodeURIComponent(DEVICE_LINK_API_BASE_URL);
          if (receiveSharedTaskInvitationIntent(url, 'clipboard')) seenInvitations.current.add(parsed.invitation);
        };
        offer();
      } catch {
        // Denied/unavailable clipboard access leaves the current page usable.
      } finally {
        reading = false;
        if (!disposed && captured !== activation && AppState.currentState === 'active') void check();
      }
    };
    const activate = (state: AppStateStatus) => {
      if (state === 'background') { background = true; activation++; deferredOffer = null; }
      if (state !== 'active') return;
      const offer = deferredOffer;
      deferredOffer = null;
      offer?.();
      if (started && !background) return;
      started = true; background = false;
      void check();
    };
    const subscription = AppState.addEventListener('change', activate);
    const stopWatchingOwner = subscribeMobileAuthOwner(() => {
      // Cancel the old owner's read; a fresh read belongs to the settled account.
      activation++; deferredOffer = null;
      if (AppState.currentState !== 'active') started = false;
      // Let the intent store retire the old owner's pending link first.
      queueMicrotask(() => { if (!disposed && AppState.currentState === 'active') void check(); });
    });
    activate(AppState.currentState);
    return () => { disposed = true; deferredOffer = null; subscription.remove(); stopWatchingOwner(); };
  }, [enabled]);
}
