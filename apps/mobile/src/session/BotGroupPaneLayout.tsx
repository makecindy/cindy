import { useSessionHeaderHeight } from './useSessionHeaderHeight';
import { useMemo, useRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { GestureDetector } from '@/platform/gestureHandler';
import { PaneViewportProvider, useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { sharedStatusRowTrailingReserve, sharedStatusRowDrawerTop } from '@/platform/windowGeometry';
import { MessageHistoryOverlay } from './RecentMessageHistories';
import { useSessionPaneLayout, useSessionSidebarWidthPreference } from './ResidentHomeList';
import { SessionListDrawer } from './SessionListDrawer';
import { SessionPaneDivider } from './SessionPaneDivider';
import { useConversationTaskDrawer } from './useConversationTaskDrawer';
import { buildWideSessionNavLayout } from './wideSessionNav';

/** Group chats use the same drawer lifecycle and retained Home as task chats. */
export function BotGroupPaneLayout({ children }: { children: ReactNode }) {
  const paneLayout = useSessionPaneLayout();
  const geometry = useAdaptiveWindow();
  const { width, height } = geometry;
  const focused = useIsFocused();
  const headerHeight = useSessionHeaderHeight(JSON.stringify([width, height, geometry.insets, geometry.barEdge]));
  const drawerTop = paneLayout.persistent ? undefined : sharedStatusRowDrawerTop(headerHeight, geometry.insets.top);
  const { threadRootId } = useLocalSearchParams<{ threadRootId?: string }>();
  const preference = useSessionSidebarWidthPreference();
  const layout = buildWideSessionNavLayout({ windowWidth: width, preferredWidth: preference.width,
    trailingReserve: sharedStatusRowTrailingReserve(geometry, headerHeight) });
  const { persistent, detail } = paneLayout;
  const drawer = useConversationTaskDrawer({ enabled: layout.enabled && !threadRootId, persistent, width: layout.drawerWidth });
  const viewport = useMemo(() => ({ x: detail.x, y: detail.y, width: detail.width, height }),
    [detail.x, detail.y, detail.width, height]);
  const retain = Platform.OS === 'ios' && geometry.regularWidth && geometry.reservedRegionsSupported;
  const retainedHeight = useRef(Math.max(1, height - (drawerTop ?? geometry.insets.top)));
  if (focused) retainedHeight.current = Math.max(1, height - (drawerTop ?? geometry.insets.top));
  return <View style={styles.root}>
    <GestureDetector gesture={drawer.sessionListDrawerPullGesture}>
      <View style={[styles.root, persistent && {
        marginLeft: detail.x, marginRight: Math.max(0, width - detail.x - detail.width),
      }]} accessibilityElementsHidden={drawer.sessionListDrawerOverlayMounted}
        importantForAccessibility={drawer.sessionListDrawerOverlayMounted ? 'no-hide-descendants' : 'auto'}>
        <PaneViewportProvider value={viewport}>{children}</PaneViewportProvider>
      </View>
    </GestureDetector>
    {!threadRootId ? <Stack.Screen options={{ gestureEnabled: !drawer.sessionListDrawerFloating && !drawer.sessionListDrawerOverlayMounted }} /> : null}
    <MessageHistoryOverlay enabled={false}>
      <SessionListDrawer currentSessionId="" persistent={persistent}
        open={persistent || drawer.sessionListDrawerOpen}
        width={persistent ? paneLayout.sidebarWidth : drawer.sessionListDrawerWidthRef.current}
        topInset={drawerTop}
        aboveSystemBar={Platform.OS === 'ios' && !persistent}
        retainedHeight={retain ? retainedHeight.current : undefined}
        onClose={drawer.closeSessionListDrawer} onClosed={drawer.handleSessionListDrawerClosed}
        onColumnReady={drawer.handleSessionListDrawerClosed}
        runNavigation={drawer.queueDrawerNavigation}
        motion={drawer.sessionListDrawerMotion}
        resize={layout.resizeBounds ? { bounds: layout.resizeBounds, onResize: preference.setWidth } : undefined} />
    </MessageHistoryOverlay>
    {persistent && paneLayout.resizeBounds ? <SessionPaneDivider width={paneLayout.sidebarWidth}
      left={detail.x} top={geometry.insets.top} bottom={geometry.insets.bottom}
      bounds={paneLayout.resizeBounds} onResize={preference.setWidth} /> : null}
  </View>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
