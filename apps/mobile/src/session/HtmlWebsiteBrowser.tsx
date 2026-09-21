import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Share, StyleSheet, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { HtmlBrowserChrome } from './HtmlBrowserChrome';
import type { HtmlBrowserChromeProps } from './HtmlBrowserChrome.types';
import { normalizeBrowserAddress, allowWebsiteNavigation } from './browserAddress';
import { useHtmlBrowserViewport } from './useHtmlBrowserViewport';
import { browserViewportScrollScript, type BrowserInsets } from './htmlBrowserViewport';

export interface WebsiteVisit { url: string; snapshotClosed: Promise<void> }

/** Separate native lifetime and ephemeral cookie store from the file preview. */
export function HtmlWebsiteBrowser({ visit, insets, chrome, onReturn }: {
  visit: WebsiteVisit;
  insets: BrowserInsets;
  chrome: Pick<HtmlBrowserChromeProps, 'top' | 'bottom' | 'left' | 'right' | 'onClose'>;
  onReturn(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const webView = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [navigation, setNavigation] = useState<WebViewNavigation | null>(null);
  const [source, setSource] = useState({ uri: visit.url });
  const [rendererEpoch, setRendererEpoch] = useState(0);
  const rendererGone = useRef(false);
  const pendingAddress = useRef<{ url: string; previous: string[] } | null>(null);
  const address = navigation?.url ?? source.uri;
  const live = useRef(true);
  const { viewRef, measure, script, viewportStyle, obscuredContentInsets } = useHtmlBrowserViewport(insets);
  useEffect(() => {
    live.current = true;
    void visit.snapshotClosed.then(() => { if (live.current) setReady(true); }, () => { if (live.current) setFailed(true); });
    return () => { live.current = false; };
  }, [visit.snapshotClosed]);
  useEffect(() => { if (script && ready) webView.current?.injectJavaScript(script); }, [script, ready]);
  const navigate = (input: string) => {
    const url = normalizeBrowserAddress(input);
    if (!url) { Alert.alert(t('files.preview.browserInvalidAddress')); return false; }
    pendingAddress.current = { url, previous: [address, source.uri] };
    setNavigation(null);
    setFailed(false);
    setSource({ uri: url });
    if (rendererGone.current) { rendererGone.current = false; setRendererEpoch(value => value + 1); }
    else if (url === address && ready) webView.current?.reload();
    return true;
  };
  return <View style={[styles.fill, { backgroundColor: colors.surface }]}>
    <View ref={viewRef} onLayout={measure} collapsable={false} style={[styles.fill, viewportStyle]}>
      <View style={styles.viewport}>
        {ready && <WebView
          key={rendererEpoch}
          ref={webView}
          testID="filePreview.website"
          source={source}
          incognito
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={request => allowWebsiteNavigation(request.url)}
          setSupportMultipleWindows={false}
          allowFileAccess={false}
          mediaCapturePermissionGrantType="deny"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          obscuredContentInsets={obscuredContentInsets}
          contentInset={obscuredContentInsets}
          injectedJavaScriptBeforeContentLoaded={script}
          injectedJavaScript={script}
          onLoadStart={event => {
            if (!live.current) return;
            if (event.nativeEvent.url === pendingAddress.current?.url) pendingAddress.current = null;
            setFailed(false);
          }}
          onLoadEnd={() => { if (live.current && script) webView.current?.injectJavaScript(script); }}
          onScroll={({ nativeEvent: { contentOffset } }) => {
            if (live.current) webView.current?.injectJavaScript(browserViewportScrollScript(contentOffset.x, contentOffset.y));
          }}
          onNavigationStateChange={state => {
            if (!live.current || !allowWebsiteNavigation(state.url)) return;
            const pending = pendingAddress.current;
            if (pending && state.url !== pending.url && pending.previous.includes(state.url)) return;
            pendingAddress.current = null;
            setNavigation(state);
            // Both native platforms skip loading when this is already the WebView's URL.
            setSource(old => old.uri === state.url ? old : { uri: state.url });
          }}
          onError={() => { if (live.current) setFailed(true); }}
          onContentProcessDidTerminate={() => { if (live.current) { rendererGone.current = true; setFailed(true); } }}
          onRenderProcessGone={() => { if (live.current) { rendererGone.current = true; setFailed(true); } }}
          style={styles.fill}
        />}
        {!ready && !failed && <View style={styles.center}><ActivityIndicator color={colors.textSecondary} /></View>}
        {failed && <View pointerEvents="none" style={[styles.center, { backgroundColor: colors.surface }]}>
          <Text style={{ color: colors.textPrimary }}>{t('files.preview.browserWebsiteFailed')}</Text>
        </View>}
      </View>
    </View>
    <HtmlBrowserChrome {...chrome}
      title={address} path={address} address={address} website
      source={false} busy={false} loading={!failed && (!ready || !navigation || navigation.loading)}
      canGoBack canGoForward={navigation?.canGoForward === true}
      onNavigate={navigate}
      onBack={() => navigation?.canGoBack ? webView.current?.goBack() : onReturn()}
      onForward={() => webView.current?.goForward()}
      onReload={() => {
        if (rendererGone.current) { rendererGone.current = false; setFailed(false); setRendererEpoch(value => value + 1); }
        else webView.current?.reload();
      }}
      onToggleSource={onReturn}
      onCopyPath={() => { void Clipboard.setStringAsync(address); }}
      onShare={() => { void Share.share(Platform.OS === 'ios' ? { url: address } : { message: address }).catch(() => {}); }}
      onAddToTask={() => {}}
    />
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  viewport: { flex: 1, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
