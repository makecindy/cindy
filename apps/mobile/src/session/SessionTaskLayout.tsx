import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { CindyMakeSessionGate } from './CindyMakeSessionGate';
import { MessageHistoryOverlay } from './RecentMessageHistories';
import { useSessionPaneLayout } from './ResidentHomeList';
import { remoteSessionStore, useRemoteSessionDetail } from './remoteSessionStore';
import { SessionListDrawer } from './SessionListDrawer';
import { switchDrawerSessionInPlace, type SessionRouteParamsNavigation } from './sessionDrawerNavigation';
import type { RemoteSessionListItem } from './sessionList';
import { SideChatTaskBoundary } from './SideChatTaskBoundary';
import type { RemoteSession } from './types';

export interface SessionTaskChrome {
  beforeSessionSwitchRef: RefObject<(() => void) | null>;
  newSessionActionRef: RefObject<(() => void) | null>;
}

/** Keep sidebar chrome outside the task lifetime. The keyed detail owns all
 * task-local state and pending completions, including when switching computers. */
export function SessionTaskLayout({ children }: {
  children(chrome: SessionTaskChrome): ReactNode;
}) {
  const params = useLocalSearchParams<{ sessionId: string; deviceId?: string; deviceName?: string; resourceHistorySessionId?: string; focusClientId?: string }>();
  const sessionId = readRouteParam(params.sessionId) ?? '';
  const deviceId = readRouteParam(params.deviceId)
    ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const session = useRemoteSessionDetail(deviceId, sessionId);
  const navigation = useNavigation<SessionRouteParamsNavigation>();
  const legacyHistory = readRouteParam(params.resourceHistorySessionId) === sessionId && !!sessionId;
  useEffect(() => {
    if (legacyHistory && deviceId) switchDrawerSessionInPlace(navigation, {
      sessionId, deviceId, deviceName: readRouteParam(params.deviceName) ?? deviceId,
      focusClientId: readRouteParam(params.focusClientId) ?? undefined,
    });
  }, [legacyHistory, deviceId, sessionId, navigation, params.deviceName, params.focusClientId]);
  const paneLayout = useSessionPaneLayout();
  const adaptiveWindow = useAdaptiveWindow();
  const { t } = useTranslation();
  const beforeSessionSwitchRef = useRef<(() => void) | null>(null);
  const newSessionActionRef = useRef<(() => void) | null>(null);
  const selectSession = useCallback((item: RemoteSessionListItem) => {
    const target = item.session as RemoteSession;
    const focusClientId = 'searchFocusClientId' in item
      ? (item as { searchFocusClientId?: string }).searchFocusClientId : undefined;
    if (target.id === sessionId && !focusClientId && !('searchLocallyCached' in item)) return;
    const targetDeviceId = target.canonicalDeviceId ?? target.deviceLinkDeviceId
      ?? remoteSessionStore.getSessionDeviceId(target.id);
    if (!targetDeviceId) {
      Alert.alert(t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    beforeSessionSwitchRef.current?.();
    switchDrawerSessionInPlace(navigation, {
      deviceId: targetDeviceId,
      deviceName: target.deviceLinkDeviceName ?? targetDeviceId,
      sessionId: target.id,
      ...(focusClientId ? { focusClientId } : {}),
    });
  }, [navigation, sessionId, t]);
  if (legacyHistory && deviceId) return null;
  return <View style={styles.root}>
    <SideChatTaskBoundary key={JSON.stringify([deviceId, sessionId])} deviceId={deviceId}
      sessionId={sessionId} enabled={session?.source === 'side-chat'}>
      <CindyMakeSessionGate sessionId={sessionId} deviceId={deviceId || undefined} ownsSessionSubscription>
        {children({ beforeSessionSwitchRef, newSessionActionRef })}
      </CindyMakeSessionGate>
    </SideChatTaskBoundary>
    <MessageHistoryOverlay enabled={false}>
      <SessionListDrawer
        currentSessionId={sessionId}
        newSessionActionRef={newSessionActionRef}
        newSessionInSystemBar={Platform.OS === 'ios' && adaptiveWindow.barEdge !== 'none'}
        onClose={ignoreClose}
        onSelectSession={selectSession}
        runNavigation={runNavigation}
        persistent={paneLayout.persistent}
        open={paneLayout.persistent}
        width={paneLayout.sidebarWidth}
      />
    </MessageHistoryOverlay>
  </View>;
}

const ignoreClose = () => undefined;
const runNavigation = (action: () => void) => action();
const styles = StyleSheet.create({ root: { flex: 1 } });

function readRouteParam(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}
