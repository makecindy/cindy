import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { remotePresentation } from '../../modules/cindy-remote-presentation/src';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { getChatInviteIntent, getChatInviteSequence, parseChatInviteLink, receiveChatInviteLink, subscribeChatInviteIntent } from './chatInviteIntent';

/** Foreground-only discovery; clipboard contents never leave memory unless they are a valid invitation. */
export function useClipboardChatInvite(enabled: boolean, owner: MobileAuthOwnerGeneration): void {
  const lastVersion = useRef<string | undefined>(undefined);
  const handledLinks = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    let disposed = false;
    let busy = false;
    let background = 0;
    let pending: { link: string; sequence: number; background: number } | undefined;
    const remember = () => {
      const invitation = getChatInviteIntent();
      const link = invitation?.link ?? invitation?.manualLink;
      if (link) handledLinks.current.add(link);
    };
    remember();
    const unsubscribe = subscribeChatInviteIntent(remember);
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const version = () => Platform.OS === 'ios'
      ? remotePresentation?.clipboardVersion?.().catch(() => undefined) ?? Promise.resolve(undefined)
      : Promise.resolve(undefined);
    const present = () => {
      if (!pending || AppState.currentState !== 'active') return;
      const target = pending;
      pending = undefined;
      if (!current() || target.background !== background || target.sequence !== getChatInviteSequence()
        || getChatInviteIntent()) return;
      if (handledLinks.current.has(target.link)) return;
      handledLinks.current.add(target.link);
      receiveChatInviteLink(target.link);
    };
    const check = async () => {
      if (!current() || busy || AppState.currentState !== 'active' || getChatInviteIntent()) return;
      busy = true;
      const started = background;
      const sequence = getChatInviteSequence();
      try {
        const before = await version();
        if (!current() || started !== background || AppState.currentState !== 'active') return;
        if (before !== undefined && before === lastVersion.current) return;
        if (!await Clipboard.hasStringAsync()) return;
        if (!current() || started !== background || sequence !== getChatInviteSequence()
          || AppState.currentState !== 'active') return;
        // The change count avoids another iOS permission prompt for the same clipboard, including denial.
        lastVersion.current = before;
        const text = await Clipboard.getStringAsync();
        if (!current()) return;
        if (started !== background) { lastVersion.current = undefined; return; }
        const after = await version();
        if (!current()) return;
        if (started !== background) { lastVersion.current = undefined; return; }
        if (before !== undefined && after !== undefined && before !== after) return;
        const link = text.length <= 8192 ? parseChatInviteLink(text.trim()) : null;
        if (link) pending = { link, sequence, background: started };
        present();
      } catch {
        // Permission denial or unavailable clipboard leaves the existing manual entry usable.
      } finally {
        busy = false;
        if (current() && started !== background && AppState.currentState === 'active') void check();
      }
    };
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') { background++; pending = undefined; }
      if (state === 'active') { present(); void check(); }
    });
    void check();
    return () => { disposed = true; pending = undefined; subscription.remove(); unsubscribe(); };
  }, [enabled, owner]);
}
