import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { PaneViewportProvider } from '@/platform/AdaptiveWindowContext';
import { MessageHistoryOverlay } from './RecentMessageHistories';
import { useSessionPaneLayout } from './ResidentHomeList';
import { SessionListDrawer } from './SessionListDrawer';

/** Group chats share the task sidebar on foldables and wide windows, like a
 * teammate's own chat. The detail keeps one tree across width changes so
 * folding or rotating never remounts the conversation. */
export function BotGroupPaneLayout({ children }: { children: ReactNode }) {
  const paneLayout = useSessionPaneLayout();
  const { width, height } = useWindowDimensions();
  const { persistent, detail } = paneLayout;
  const viewport = useMemo(() => ({ x: detail.x, y: detail.y, width: detail.width, height }),
    [detail.x, detail.y, detail.width, height]);
  return <View style={styles.root}>
    <View style={[styles.root, persistent && {
      marginLeft: detail.x, marginRight: Math.max(0, width - detail.x - detail.width),
    }]}>
      <PaneViewportProvider value={viewport}>{children}</PaneViewportProvider>
    </View>
    {persistent ? <MessageHistoryOverlay enabled={false}>
      {/* Without an onSelectSession override Home opens tasks, teammates and
          groups through its normal guarded navigation. */}
      <SessionListDrawer currentSessionId="" persistent open width={paneLayout.sidebarWidth}
        onClose={ignoreClose} runNavigation={runNavigation} />
    </MessageHistoryOverlay> : null}
  </View>;
}

const ignoreClose = () => undefined;
const runNavigation = (action: () => void) => action();
const styles = StyleSheet.create({ root: { flex: 1 } });
