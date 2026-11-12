/**
 * AnnotationBurnInWebView — 标注烧录的隐藏 WebView host(手机版)。
 *
 * RN 没有 DOM canvas,烧录(原图 + 矢量笔迹 → 位图)在一个 1x1 隐藏 WebView
 * 里完成:canvas 重放脚本内联跨端共享核心(见 imageAnnotationModel 的
 * buildAnnotationBurnInHtml),纯 JS 方案零新增原生依赖,可随 OTA 热更。
 *
 * useAnnotationBurnIn() 返回 promise 风格的 burnIn API 与 host 元素;host 按需
 * 挂载(有任务或被预热时才渲染 WebView,空闲零开销),任务串行执行,页面把
 * host 挂在任意稳定位置即可。队列、超时、崩溃恢复与预热见 annotationBurnInQueue。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  createAnnotationBurnInQueue,
  type AnnotationBurnInInput,
  type AnnotationBurnInResult,
} from '@/session/annotationBurnInQueue';
import { buildAnnotationBurnInHtml } from '@/session/imageAnnotationModel';

export type { AnnotationBurnInInput, AnnotationBurnInResult } from '@/session/annotationBurnInQueue';

export interface UseAnnotationBurnInResult {
  /** 烧录一张图;失败(解码/编码/超时/WebView 崩溃)reject,调用方自行降级。 */
  burnIn: (input: AnnotationBurnInInput) => Promise<AnnotationBurnInResult>;
  /**
   * 预热:进入标注模式时调用,提前挂载 WebView,提交时省掉冷启动;返回的释放
   * 函数(幂等)在退出标注 / 关闭查看器时调用,空闲后照常卸载。
   */
  acquireWarm: () => () => void;
  /** 挂到页面任意稳定位置;无任务且未预热时为 null。 */
  host: ReactElement | null;
}

export function useAnnotationBurnIn(): UseAnnotationBurnInResult {
  // hostKey 只驱动 WebView 挂载/卸载(并作为 React key 保证每次都是全新实例);
  // 任务真相全在 queue 里。
  const [hostKey, setHostKey] = useState<number | null>(null);
  const webViewRef = useRef<WebView | null>(null);
  const mountedKeyRef = useRef<number | null>(null);

  const queue = useMemo(() => createAnnotationBurnInQueue({
    mount: (key) => {
      mountedKeyRef.current = key;
      setHostKey(key);
    },
    unmount: () => {
      mountedKeyRef.current = null;
      setHostKey(null);
    },
    inject: (key, script) => {
      const webView = webViewRef.current;
      if (mountedKeyRef.current !== key || !webView) return false;
      webView.injectJavaScript(script);
      return true;
    },
  }), []);

  // host 卸载(页面退出/失焦销毁)时在飞与排队任务全部显式 reject:不兜底的话
  // burnIn promise 永不 settle,调用方的失败链路(Alert / 信箱回投)不会跑。
  useEffect(() => () => queue.dispose(), [queue]);

  const burnIn = useCallback((input: AnnotationBurnInInput) => queue.burnIn(input), [queue]);
  const acquireWarm = useCallback(() => queue.acquireWarm(), [queue]);

  const host = useMemo<ReactElement | null>(() => {
    if (hostKey === null) return null;
    const key = hostKey;
    const onMessage = (event: WebViewMessageEvent) => queue.handleMessage(key, event.nativeEvent.data);
    return (
      <View pointerEvents="none" style={styles.hidden}>
        <WebView
          javaScriptEnabled
          key={key}
          onContentProcessDidTerminate={() => queue.handleProcessGone(key, 'content process terminated')}
          onError={() => queue.handleProcessGone(key, 'load error')}
          onMessage={onMessage}
          // Android 渲染进程被杀:提供该回调同时避免宿主 App 随之崩溃;实例作废后换新。
          onRenderProcessGone={() => queue.handleProcessGone(key, 'render process gone')}
          originWhitelist={['*']}
          ref={webViewRef}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          source={{ html: buildAnnotationBurnInHtml(), baseUrl: 'https://xdt-maker-mobile.local' }}
          style={styles.webView}
        />
      </View>
    );
  }, [hostKey, queue]);

  return { burnIn, acquireWarm, host };
}

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  webView: { height: 1, width: 1 },
});
