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
import { resolvedUrlKind, sanitizeDiagnosticText } from '@/debug/fileDiagnostics';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { useTheme } from '@/theme';

export function RemoteMediaPlayerWebView({
  kind,
  mimeType,
  onStatusChange,
  style,
  testID,
  title,
  url,
  visible = true,
}: {
  kind: MobileMediaPlayerKind;
  mimeType?: string;
  onStatusChange?: (status: MobileMediaPlayerStatus) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title?: string;
  url: string;
  /** 所在页是否为当前可见页:失活(翻页/压栈)时暂停播放,回到本页不自动续播。缺省 true(消息卡片等无翻页场景)。 */
  visible?: boolean;
}) {
  const { colors } = useTheme();
  const webViewRef = useRef<ComponentRef<typeof WebView>>(null);
  const lifecycleRef = useRef(createMediaPlayerWebViewLifecycle());
  const mountedRef = useRef(true);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  useEffect(() => registerMobileMessageWebView('media'), []);
  // Diagnostics: which URL scheme reached the player and how its load/playback went (never the URL).
  const lastLoggedStateRef = useRef<string | null>(null);
  const loadStartedAtRef = useRef(Date.now());
  useEffect(() => {
    lastLoggedStateRef.current = null;
    loadStartedAtRef.current = Date.now();
    mobileDebugLog('debug', 'files', 'media player mounted', {
      kind, mimeType: mimeType ?? null, source: resolvedUrlKind(url), reloadGeneration,
    });
  }, [kind, mimeType, reloadGeneration, url]);
  const logPlayerFailure = useCallback((event: string, detail: Record<string, unknown>) => {
    mobileDebugLog('warn', 'files', event, { kind, ms: Date.now() - loadStartedAtRef.current, ...detail });
  }, [kind]);
  const pausePlayback = useCallback(() => {
    webViewRef.current?.postMessage(buildMediaPlayerWebViewCommand('pause'));
  }, []);
  const stopPlaybackAndLoading = useCallback(() => {
    pausePlayback();
    webViewRef.current?.stopLoading();
  }, [pausePlayback]);

  // 失活即暂停(review P1):预览 pager 用 windowSize={3} 保留相邻页,相邻页的
  // active 仍为 true,不把可见性接进播放器的话,用户滑走后上一页的媒体还在后台
  // 继续播。判定在纯生命周期模块(行为级用例在 mediaPlayerWebView.test.ts),
  // 这里只发 pause 命令;回到本页不自动续播,播放权交还用户。
  useEffect(() => {
    if (lifecycleRef.current.onVisibilityChange(visible)) pausePlayback();
  }, [pausePlayback, visible]);

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
    if (status && status.state !== lastLoggedStateRef.current) {
      lastLoggedStateRef.current = status.state;
      mobileDebugLog(status.state === 'error' ? 'warn' : 'debug', 'files', 'media player state', {
        kind,
        state: status.state,
        ms: Date.now() - loadStartedAtRef.current,
        duration: status.duration ?? null,
        mediaError: status.error ? sanitizeDiagnosticText(status.error) : null,
      });
    }
    if (status) onStatusChange?.(status);
  }, [kind, onStatusChange]);

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
        onError={(event) => logPlayerFailure('media player load error', {
          code: event?.nativeEvent?.code, domain: event?.nativeEvent?.domain,
          description: sanitizeDiagnosticText(String(event?.nativeEvent?.description ?? '')),
        })}
        onContentProcessDidTerminate={() => logPlayerFailure('media player process terminated', {})}
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
