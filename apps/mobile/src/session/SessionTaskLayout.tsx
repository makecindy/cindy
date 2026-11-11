import { SessionDrawerNavigationContext } from './SessionDrawerNavigationContext';
import { drawerConversationTarget, taskListEntryParams } from './taskListNavigationPolicy';
import { forwardNavigationLock } from '@/utils/navigationLock';
import type { Href } from 'expo-router';
import { deviceDisplayName } from '@/device-link/deviceName';
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { useAdaptiveWindow, useAdaptiveWindowDimensions } from '@/platform/AdaptiveWindowContext';
import { useSessionHeaderHeight } from './useSessionHeaderHeight';
import { CindyMakeSessionGate } from './CindyMakeSessionGate';
import { SessionTaskDrawerProvider } from './SessionTaskDrawer';
import { buildWideSessionNavLayout } from './wideSessionNav';
import { sharedStatusRowTrailingReserve } from '@/platform/windowGeometry';
import { useSessionPaneLayout, useSessionSidebarWidthPreference } from './ResidentHomeList';
import { remoteSessionStore, useRemoteSessionDetail } from './remoteSessionStore';
import { SessionListDrawer } from './SessionListDrawer';
import { switchDrawerSessionInPlace, taskListSessionTarget, type SessionRouteParamsNavigation } from './sessionDrawerNavigation';
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
  const params = useLocalSearchParams<{ sessionId: string; deviceId?: string; deviceName?: string; resourceHistorySessionId?: string; resourceId?: string; focusClientId?: string; taskListEntry?: string }>();
  const sessionId = readRouteParam(params.sessionId) ?? '';
  const deviceId = readRouteParam(params.deviceId)
    ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const session = useRemoteSessionDetail(deviceId, sessionId);
  const navigation = useNavigation<SessionRouteParamsNavigation>();
  const legacyHistory = readRouteParam(params.resourceHistorySessionId) === sessionId && !!sessionId;
  useEffect(() => {
    if (legacyHistory && deviceId) switchDrawerSessionInPlace(navigation, {
      sessionId, deviceId, deviceName: deviceDisplayName(deviceId, readRouteParam(params.deviceName)),
      focusClientId: readRouteParam(params.focusClientId) ?? undefined,
      ...taskListEntryParams(params),
    });
  }, [legacyHistory, deviceId, sessionId, navigation, params.deviceName, params.focusClientId, params.taskListEntry]);
  const paneLayout = useSessionPaneLayout();
  const adaptiveWindow = useAdaptiveWindow();
  const dimensions = useAdaptiveWindowDimensions();
  const nativeHeaderHeight = useSessionHeaderHeight(JSON.stringify([
    dimensions.width, dimensions.height, dimensions.fontScale,
    adaptiveWindow.insets.top, adaptiveWindow.insets.bottom, adaptiveWindow.insets.left, adaptiveWindow.insets.right, adaptiveWindow.barEdge,
  ]));
  const focused = useIsFocused();
  const sidebarWidthPreference = useSessionSidebarWidthPreference();
  const floatingWidth = buildWideSessionNavLayout({ windowWidth: adaptiveWindow.width,
    preferredWidth: sidebarWidthPreference.width, trailingReserve: sharedStatusRowTrailingReserve(adaptiveWindow, nativeHeaderHeight) }).drawerWidth;
  const shareDrawer = Platform.OS === 'ios' && adaptiveWindow.regularWidth && adaptiveWindow.reservedRegionsSupported
    && (adaptiveWindow.barEdge !== 'none' || adaptiveWindow.regions.some(region => region.kind === 'occlusion'));
  const { t } = useTranslation();
  const beforeSessionSwitchRef = useRef<(() => void) | null>(null);
  const newSessionActionRef = useRef<(() => void) | null>(null);
  const switchConversation = useCallback((href: Href) => {
    const target = drawerConversationTarget(href);
    if (!target) return false;
    if (target.deviceId === deviceId && target.sessionId === sessionId
      && (target.resourceId ?? null) === readRouteParam(params.resourceId)
      && !target.focusClientId && !target.companionSettings) return true;
    beforeSessionSwitchRef.current?.();
    switchDrawerSessionInPlace(navigation, target);
    return true;
  }, [navigation, deviceId, sessionId, params.resourceId]);
  // In-place navigation has no native transitionEnd. Release after the new identity commits.
  const committedIdentity = useRef(JSON.stringify([deviceId, sessionId]));
  useEffect(() => {
    const identity = JSON.stringify([deviceId, sessionId]);
    if (identity === committedIdentity.current) return;
    committedIdentity.current = identity;
    forwardNavigationLock.reset();
  }, [deviceId, sessionId]);

  const selectSession = useCallback((item: RemoteSessionListItem) => {
    const target = item.session as RemoteSession;
    const focusClientId = 'searchFocusClientId' in item
      ? (item as { searchFocusClientId?: string }).searchFocusClientId : undefined;
    if (target.id === sessionId && !focusClientId && !('searchLocallyCached' in item)) return;
    const destination = taskListSessionTarget(item, id => remoteSessionStore.getSessionDeviceId(id));
    if (!destination) {
      Alert.alert(t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    beforeSessionSwitchRef.current?.();
    switchDrawerSessionInPlace(navigation, destination);
  }, [navigation, sessionId, t]);
  if (legacyHistory && deviceId) return null;
  return <SessionDrawerNavigationContext.Provider value={switchConversation}><View style={styles.root}>
    <SessionTaskDrawerProvider enabled={shareDrawer} focused={focused}
      windowHeight={adaptiveWindow.height} topInset={adaptiveWindow.insets.top} floatingWidth={floatingWidth}
      column={
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
      }>
      <SideChatTaskBoundary key={JSON.stringify([deviceId, sessionId])} deviceId={deviceId}
        sessionId={sessionId} enabled={session?.source === 'side-chat'}>
        <CindyMakeSessionGate sessionId={sessionId} deviceId={deviceId || undefined} ownsSessionSubscription>
          {children({ beforeSessionSwitchRef, newSessionActionRef })}
        </CindyMakeSessionGate>
      </SideChatTaskBoundary>
    </SessionTaskDrawerProvider>
  </View></SessionDrawerNavigationContext.Provider>;
}

const ignoreClose = () => undefined;
const runNavigation = (action: () => void) => action();
const styles = StyleSheet.create({ root: { flex: 1 } });

function readRouteParam(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}
