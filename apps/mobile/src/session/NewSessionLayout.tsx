import { useCallback, useMemo, type ReactNode, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import {
  PaneViewportProvider,
  useAdaptiveWindow,
} from "@/platform/AdaptiveWindowContext";
import { useTheme } from "@/theme";
import { MessageHistoryOverlay } from "./RecentMessageHistories";
import { useSessionPaneLayout } from "./ResidentHomeList";
import { SessionListDrawer } from "./SessionListDrawer";

/** Keep the form mounted when the window changes between one and two panes. */
export function NewSessionLayout({
  children,
  creatingRef,
}: {
  children: ReactNode;
  creatingRef: RefObject<boolean>;
}) {
  const window = useAdaptiveWindow();
  const pane = useSessionPaneLayout();
  const { colors } = useTheme();
  // Read the submission lock at tap time, including before React renders busy UI.
  const runNavigation = useCallback(
    (action: () => void) => {
      if (!creatingRef.current) action();
    },
    [creatingRef],
  );
  const viewport = useMemo(
    () => ({
      ...pane.detail,
      height: window.height,
    }),
    [
      pane.detail.x,
      pane.detail.y,
      pane.detail.width,
      pane.detail.height,
      window.height,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <PaneViewportProvider value={viewport}>
        <View
          style={[
            styles.root,
            pane.persistent && {
              marginLeft: pane.detail.x,
              marginRight: Math.max(
                0,
                window.width - pane.detail.x - pane.detail.width,
              ),
            },
          ]}
        >
          {children}
        </View>
      </PaneViewportProvider>
      <MessageHistoryOverlay enabled={false}>
        <SessionListDrawer
          currentSessionId=""
          persistent={pane.persistent}
          open={pane.persistent}
          width={pane.sidebarWidth}
          onClose={ignoreClose}
          runNavigation={runNavigation}
        />
      </MessageHistoryOverlay>
    </View>
  );
}

const ignoreClose = () => undefined;
const styles = StyleSheet.create({ root: { flex: 1 } });
