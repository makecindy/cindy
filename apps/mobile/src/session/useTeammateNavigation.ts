import { useCallback, useEffect, useRef } from 'react';
import { useNavigation, useRouter } from 'expo-router';
import { Keyboard } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import type { RemoteResourceRef } from '@cindy/device-link';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useHomeMode } from './useHomeMode';
import type { HomeMode } from './homeViewPreferenceStore';
import { homeDismissCount, teammateIdentity, teammateResourceRoute } from './teammateNavigation';
import { readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';

/** Push keeps the current chat/composer mounted; known teammates validate in the destination. */
export function useTeammateNavigation() {
  const preferences = useHomeMode();
  const { user, accountGeneration } = useAuth();
  const { i18n } = useTranslation();
  const push = useGuardedPush();
  const router = useRouter();
  const navigation = useNavigation();
  const current = useRef(accountGeneration); current.current = accountGeneration;
  const pendingAccount = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const chooseMode = useCallback(async (mode: HomeMode) => {
    if (pendingAccount.current === accountGeneration) return;
    pendingAccount.current = accountGeneration;
    Keyboard.dismiss();
    try {
      await preferences.setMode(mode);
      if (mounted.current && current.current === accountGeneration) {
        const state = navigation.getState();
        const count = homeDismissCount(state?.routes.slice(0, state.index + 1) ?? [], mode);
        // Pop by position: dismissTo would overwrite a legacy collection's target params.
        if (count === null) router.dismissTo('/devices');
        else if (count > 0) router.dismiss(count);
      }
    } finally { if (pendingAccount.current === accountGeneration) pendingAccount.current = null; }
  }, [accountGeneration, navigation, preferences.setMode, router]);
  const openTeammate = useCallback(async (hosted: HostedRemoteCollectionItem) => {
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
        push(teammateResourceRoute(hosted, i18n.language));
      }
    } finally { if (pendingAccount.current === accountGeneration) pendingAccount.current = null; }
  }, [accountGeneration, i18n.language, preferences.selectTeammate, push, user?.id]);
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
  return { ...preferences, chooseMode, openTeammate, openCreatedTeammate };
}
