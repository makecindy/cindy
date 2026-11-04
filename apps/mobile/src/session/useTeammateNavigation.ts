import { useCallback, useEffect, useRef } from 'react';
import { useNavigation, useRouter } from 'expo-router';
import { Keyboard } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import type { RemoteResourceRef } from '@cindy/device-link';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useHomeMode } from './useHomeMode';
import { homeDismissCount, staleCompanionChatCount, teammateIdentity, teammateResourceRoute, teammateSessionPreview } from './teammateNavigation';
import { remoteSessionStore } from './remoteSessionStore';
import { readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';

/** Push keeps the current chat/composer mounted; known teammates validate in the destination. */
export function useTeammateNavigation(hostPush?: ReturnType<typeof useGuardedPush>) {
  const preferences = useHomeMode();
  const { user, accountGeneration } = useAuth();
  const { i18n } = useTranslation();
  const guardedPush = useGuardedPush();
  // Defer only the final dispatch: selection and its account/mount guards must finish while the
  // drawer still exists. The host then closes/unmounts the drawer before executing the push.
  const push = hostPush ?? guardedPush;
  const router = useRouter();
  const navigation = useNavigation();
  const current = useRef(accountGeneration); current.current = accountGeneration;
  const pendingAccount = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** Back to the home, whose teammate section replaced the separate teammate list. */
  const returnHome = useCallback(() => {
    if (pendingAccount.current === accountGeneration) return;
    Keyboard.dismiss();
    const state = navigation.getState();
    const routes = state?.routes.slice(0, state.index + 1) ?? [];
    const count = homeDismissCount(routes);
    // Pop by position to preserve the mounted home's state.
    if (count === null) {
      const legacyIndex = routes.findIndex(route => route.name === 'resources/[collectionId]'
        && (route.params as { collectionId?: string } | undefined)?.collectionId === 'teammates');
      // POP_TO only replaces the top when home is absent, leaving the retired route underneath.
      if (legacyIndex >= 0) navigation.reset({
        index: legacyIndex,
        routes: [...routes.slice(0, legacyIndex), { name: 'devices/index' }],
      } as never);
      else router.dismissTo('/devices');
    }
    else if (count > 0) router.dismiss(count);
  }, [accountGeneration, navigation, router]);
  /**
   * `replace` swaps the current screen (the cloud view handing over to the new main computer);
   * `leaving` also drops that companion's chat on the computer being left from under it, so back goes to the list.
   */
  const openTeammate = useCallback(async (hosted: HostedRemoteCollectionItem,
    options?: { replace?: boolean; leaving?: { botId: string; deviceId: string }; settings?: 'capabilities' }) => {
    const identity = teammateIdentity(hosted);
    if (!identity || pendingAccount.current === accountGeneration) return;
    // Fence rapid taps before the async preference write, not only at router.push.
    pendingAccount.current = accountGeneration;
    Keyboard.dismiss();
    try {
      await preferences.selectTeammate(identity);
      if (mounted.current && current.current === accountGeneration) {
        const owner = `${user?.id ?? ''}:${accountGeneration}`;
        const cached = readRemoteCollectionCache(owner, identity.collectionId);
        // Seed presentation from the clicked row, never an authorization result.
        writeRemoteCollectionCache(owner, identity.collectionId, [hosted, ...cached.filter(row => row.key !== hosted.key)].slice(0, 200));
        const preview = teammateSessionPreview(hosted, user?.id ?? '', i18n.language);
        // The home task cache is bounded and may not contain this canonical task.
        // Seed only missing local presentation, never replace real metadata or create a task.
        if (preview && !remoteSessionStore.getSessions().some(session => session.id === preview.id)
          && !remoteSessionStore.getSessionDeviceId(preview.id)) {
          remoteSessionStore.upsertDeviceSession(hosted.host.deviceId, hosted.host.deviceName, preview);
        }
        const route = teammateResourceRoute(hosted, i18n.language, options?.settings);
        const state = options?.replace && options.leaving ? navigation.getState() : null;
        const routes = state?.routes.slice(0, state.index + 1) ?? [];
        const stale = options?.leaving ? staleCompanionChatCount(routes, options.leaving.botId, options.leaving.deviceId) : 0;
        if (stale > 0) navigation.reset({
          index: routes.length - stale - 1,
          routes: [...routes.slice(0, routes.length - 1 - stale), { name: route.pathname.slice(1), params: route.params }],
        } as never);
        else if (options?.replace) router.replace(route);
        else push(route);
      }
    } finally { if (pendingAccount.current === accountGeneration) pendingAccount.current = null; }
  }, [accountGeneration, i18n.language, navigation, preferences.selectTeammate, push, router, user?.id]);
  const openCreatedTeammate = useCallback(async (host: RemoteResourceHostTarget, ref: RemoteResourceRef) => {
    if (!mounted.current || current.current !== accountGeneration || !host.deviceId || !ref.id || !ref.collectionId
      || ref.kind !== 'bot' || pendingAccount.current === accountGeneration) return;
    pendingAccount.current = accountGeneration;
    Keyboard.dismiss();
    try {
      await preferences.selectTeammate({ deviceId: host.deviceId, collectionId: ref.collectionId, resourceKind: 'bot', resourceId: ref.id });
      if (mounted.current && current.current === accountGeneration) push({
        pathname: '/resources/[collectionId]/[resourceId]',
        params: { deviceId: host.deviceId, deviceName: host.deviceName, collectionId: ref.collectionId, resourceKind: ref.kind, resourceId: ref.id },
      });
    } finally { if (pendingAccount.current === accountGeneration) pendingAccount.current = null; }
  }, [accountGeneration, preferences.selectTeammate, push]);
  return { ...preferences, returnHome, openTeammate, openCreatedTeammate };
}
