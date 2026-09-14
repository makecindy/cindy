import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { AppState, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildMediaPlayerWebViewCommand,
  buildMediaPlayerWebViewHtml,
  parseMediaPlayerWebViewMessage,
  type MobileMediaPlayerKind,
  type MobileMediaPlayerStatus,
} from '@/session/mediaPlayerWebViewHtml';
import { createMediaPlayerWebViewLifecycle } from '@/session/mediaPlayerWebViewLifecycle';
import { registerMobileMessageWebView } from '@/session/mobileMessageWebViewMetrics';
import { useTheme } from '@/theme';

export function RemoteMediaPlayerWebView({
  kind,
  mimeType,
  onStatusChange,
  style,
  testID,
  title,
  url,
}: {
  kind: MobileMediaPlayerKind;
  mimeType?: string;
  onStatusChange?: (status: MobileMediaPlayerStatus) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title?: string;
  url: string;
}) {
  const { colors } = useTheme();
  const webViewRef = useRef<ComponentRef<typeof WebView>>(null);
  const lifecycleRef = useRef(createMediaPlayerWebViewLifecycle());
  const mountedRef = useRef(true);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  useEffect(() => registerMobileMessageWebView('media'), []);
  const pausePlayback = useCallback(() => {
    webViewRef.current?.postMessage(buildMediaPlayerWebViewCommand('pause'));
  }, []);
  const stopPlaybackAndLoading = useCallback(() => {
    pausePlayback();
    webViewRef.current?.stopLoading();
  }, [pausePlayback]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        lifecycleRef.current.onBackground();
        stopPlaybackAndLoading();
        return;
      }
      if (lifecycleRef.current.consumeReloadOnActive()) {
        setReloadGeneration(generation => generation + 1);
      }
    });
    return () => {
      subscription.remove();
      stopPlaybackAndLoading();
    };
  }, [stopPlaybackAndLoading]);

  useEffect(() => {
    return stopPlaybackAndLoading;
  }, [kind, stopPlaybackAndLoading, url]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPlaybackAndLoading();
    };
  }, [stopPlaybackAndLoading]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current) return;
    const status = parseMediaPlayerWebViewMessage(event.nativeEvent.data);
    if (status) onStatusChange?.(status);
  }, [onStatusChange]);

  return (
    <View style={style} testID={testID}>
      <WebView
        key={reloadGeneration}
        ref={webViewRef}
        allowsInlineMediaPlayback
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        onLoadEnd={lifecycleRef.current.onLoadEnd}
        onLoadStart={lifecycleRef.current.onLoadStart}
        onMessage={handleMessage}
        originWhitelist={['*']}
        scrollEnabled={false}
        source={{
          html: buildMediaPlayerWebViewHtml({
            kind,
            mimeType,
            title,
            url,
            surface: colors.surface,
            chip: colors.surfaceChip,
          }),
          baseUrl: 'https://xdt-maker-mobile.local',
        }}
        style={{ backgroundColor: 'transparent', flex: 1 }}
      />
    </View>
  );
}
