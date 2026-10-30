import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { mcpAppFrameUrlAllowed } from '@cindy/maker-shared/mcp-apps';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTheme } from '@/theme';
import { NativeMcpAppHost, NativeMcpAppSlot, mcpAppSurfaceAvailable } from './NativeMcpAppSurface';
import { McpAppView } from './mcpAppView';

const Context = createContext<{
  foreground: boolean;
  open(deviceId: string, sessionId: string, clientId: string, context: Record<string, unknown>): McpAppView;
} | null>(null);
export const useMcpAppViews = () => useContext(Context);
export { NativeMcpAppSlot, mcpAppSurfaceAvailable };

/** Hosts stay at the app root; native slots place their content inline inside
 * the real navigation screen. No root overlay, coordinates or touch interception. */
export function McpAppViewsProvider({ children }: { children: ReactNode }) {
  const { invoke } = useDeviceLink();
  const views = useRef(new Set<McpAppView>());
  const mounted = useRef(true);
  const [, refresh] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const changed = useCallback(() => { if (mounted.current) refresh((n) => n + 1); }, []);
  const open = useCallback((deviceId: string, sessionId: string, clientId: string, context: Record<string, unknown>) => {
    const view = new McpAppView(invoke, deviceId, sessionId, clientId, changed,
      () => { views.current.delete(view); changed(); }, async (url) => {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error('MCP_APP_INVALID_LINK');
        await Linking.openURL(parsed.href);
      });
    views.current.add(view);
    changed();
    void view.open(context);
    return view;
  }, [invoke, changed]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      if (!active) for (const view of views.current) void view.close();
      setForeground(active);
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      for (const view of views.current) void view.close();
    };
  }, []);
  const value = useMemo(() => ({ foreground, open }), [foreground, open]);
  const Host = NativeMcpAppHost;
  const hosted = Host ? [...views.current].map((view) => <Host key={view.id} surfaceId={view.id}
    pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ position: 'absolute', left: -100_000, top: 0, width: view.width, height: view.state.height }}>
    <McpAppWebView view={view} />
  </Host>) : null;
  return <Context.Provider value={value}>
    <View style={styles.root}>
      {children}
      {hosted}
    </View>
  </Context.Provider>;
}

function McpAppWebView({ view }: { view: McpAppView }) {
  const { colors } = useTheme();
  const { document, nativeDocument } = view;
  const bind = useCallback((webview: WebView | null) => {
    view.inject = webview ? (script) => webview.injectJavaScript(script) : undefined;
  }, [view]);
  if (!document || !nativeDocument) return null;
  return <WebView ref={bind} source={nativeDocument.source}
    style={{ height: view.state.height, backgroundColor: colors.surface }}
    originWhitelist={['*']} allowFileAccess={false} allowUniversalAccessFromFileURLs={false}
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
    incognito={Platform.OS === 'ios'} cacheEnabled={false} domStorageEnabled
    // A different loopback origin per View isolates web storage. Android's
    // incognito prop clears the process-wide cookie jar, breaking other Apps.
    javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
    allowsInlineMediaPlayback={false} mediaPlaybackRequiresUserAction
    onShouldStartLoadWithRequest={(request) => {
      if (nativeDocument.documentUrls.slice(0, 2).includes(request.url)) return true;
      return request.isTopFrame !== true && (nativeDocument.documentUrls.includes(request.url) ||
        mcpAppFrameUrlAllowed(request.url, document.policy?.frameDomains));
    }}
    onMessage={(event) => view.receive(event.nativeEvent.data)}
    onError={() => view.fail(new Error('MCP_APP_LOAD_FAILED'))}
    onContentProcessDidTerminate={() => view.fail(new Error('MCP_APP_PROCESS_TERMINATED'))}
    onRenderProcessGone={() => view.fail(new Error('MCP_APP_PROCESS_TERMINATED'))}
  />;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
