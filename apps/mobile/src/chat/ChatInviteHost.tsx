import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';
import { botGroupRoute } from '@/session/botGroupNavigation';
import { ChatInviteSheet } from './ChatInviteSheet';
import { closeChatInvite, getChatInviteIntent, setManualChatInviteLink, useChatInviteIntent } from './chatInviteIntent';
import { useClipboardChatInvite } from './useClipboardChatInvite';

/** Single presentation owner for both the Home action and external links. */
export function ChatInviteHost({ ready }: { ready: boolean }) {
  const auth = useAuth();
  const invitation = useChatInviteIntent();
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner, getMobileAuthOwner);
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const visible = ready && !!owner.accountKey && !owner.switching && auth.user?.id === owner.accountId;
  useClipboardChatInvite(visible, owner);
  const active = useRef(visible);
  active.current = visible;
  // Sheet reports success after native dismissal. Clear the credential at
  // onClose, but keep the same empty instance alive for that final callback.
  const presentedId = useRef<number | null>(null);
  const closing = useRef<{ id: number; owner: MobileAuthOwnerGeneration } | null>(null);
  if (invitation && invitation.id !== presentedId.current) {
    presentedId.current = invitation.id;
    closing.current = null;
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const id = presentedId.current;
  if (id === null) return null;
  const isCurrentOwner = () => mounted.current && active.current && isMobileAuthOwnerCurrent(owner);

  return (
    <ChatInviteSheet
      key={id}
      visible={visible && !!invitation}
      retainTargetWhenHidden={!!invitation && !visible}
      link={invitation?.link}
      hasOtherInvitation={invitation?.hasOtherInvitation ?? false}
      onTargetChange={(link) => { if (isCurrentOwner()) setManualChatInviteLink(id, link); }}
      onClose={() => {
        if (!isCurrentOwner() || getChatInviteIntent()?.id !== id) return;
        closing.current = { id, owner };
        closeChatInvite(id);
      }}
      onJoined={(groupId) => {
        const dismissed = closing.current;
        if (!isCurrentOwner() || presentedId.current !== id || getChatInviteIntent()
          || dismissed?.id !== id || !isMobileAuthOwnerCurrent(dismissed.owner)) return;
        closing.current = null;
        const route = botGroupRoute({ deviceId: '', deviceName: '' }, groupId);
        const state = navigation.getRootState();
        // Reset the nested app stack; Expo's __root only accepts its own routes.
        const rootRoute = state?.routes[state.index];
        const nested = rootRoute?.name === '__root' ? rootRoute.state : undefined;
        const appStack = nested ?? state;
        const routes = appStack?.routes.slice(0, (appStack.index ?? 0) + 1) ?? [];
        let home = -1;
        for (let index = routes.length - 1; index >= 0; index--) {
          if (routes[index].name === 'devices/index' || routes[index].name === 'index') { home = index; break; }
        }
        if (home >= 0 && home === routes.length - 1) { router.push(route); return; }
        // Keep the mounted home below the joined group for every back action.
        const homeStack = home >= 0 ? routes.slice(0, home + 1) : [{ name: 'devices/index' }];
        const nextStack = { index: homeStack.length, routes: [
          ...homeStack, { name: route.pathname.slice(1), params: route.params },
        ] };
        navigation.resetRoot((nested && state ? {
          ...state,
          routes: state.routes.map((entry, index) => index === state.index
            ? { ...entry, state: nextStack } : entry),
        } : nextStack) as Parameters<typeof navigation.resetRoot>[0]);
      }}
    />
  );
}
