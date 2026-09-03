import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { buildMermaidWebViewHtml } from '@/session/mermaidWebViewHtml';
import { registerMobileMessageWebView } from '@/session/mobileMessageWebViewMetrics';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius } from '@/theme/tokens';

/** 导出光栅化倍率(相对 SVG 固有尺寸;WebView 内按 canvas 上限收敛)。 */
const EXPORT_PNG_SCALE = 3;
/** 单次导出超时:序列化 + 解码 + 光栅化在低端机上也应远低于此。 */
const EXPORT_TIMEOUT_MS = 10_000;
const EXPORT_TMP_DIR_NAME = 'mermaid-export';

export interface MermaidDiagramWebViewHandle {
  /** 把当前已渲染的 SVG 光栅化为 PNG(纯 base64,无 data: 前缀);未渲染/失败 reject。 */
  exportPng(): Promise<string>;
}

interface PendingExport {
  resolve: (base64: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const MermaidDiagramWebView = forwardRef<MermaidDiagramWebViewHandle, {
  /** true 时去掉 chip 边框/圆角(沉浸式全屏查看器形态,图表铺满到屏幕边缘)。 */
  bare?: boolean;
  /** true 时首屏不闪源码(干净背景等 SVG 浮现,源码仅作失败降级);详情查看器用。 */
  deferSource?: boolean;
  /** true 时容器 flex:1 填满父级(父级须有确定高度,如详情页的 flex frame),忽略 height。 */
  fill?: boolean;
  height?: number;
  source: string;
  testID?: string;
  /** true 时页面允许双指缩放(详情查看用;内联预览保持锁定)。 */
  zoomable?: boolean;
  active?: boolean;
}>(function MermaidDiagramWebView({
  active = true,
  bare = false,
  deferSource = false,
  fill = false,
  height = 220,
  source,
  testID,
  zoomable = false,
}, ref) {
  const styles = useThemedStyles(makeStyles);
  const { colors, mode } = useTheme();
  const webViewRef = useRef<WebView | null>(null);
  // 导出任务信箱(id → promise 两端):按 id 配对回包,超时/卸载显式 reject。
  const pendingExportsRef = useRef(new Map<string, PendingExport>());
  const exportSeqRef = useRef(0);

  useEffect(() => {
    if (!active) return undefined;
    return registerMobileMessageWebView('mermaid');
  }, [active]);

  useImperativeHandle(ref, () => ({
    exportPng() {
      return new Promise<string>((resolve, reject) => {
        const webView = webViewRef.current;
        if (!webView) {
          reject(new Error('mermaid webview not mounted'));
          return;
        }
        exportSeqRef.current += 1;
        const id = `export-${exportSeqRef.current}`;
        const timer = setTimeout(() => {
          pendingExportsRef.current.delete(id);
          reject(new Error('mermaid export timed out'));
        }, EXPORT_TIMEOUT_MS);
        pendingExportsRef.current.set(id, { resolve, reject, timer });
        // 就绪检查:页面脚本尚未执行到导出函数定义时(极早点击),立即回传
        // not-ready 失败,不让调用方干等 10s 超时(review P2)。
        webView.injectJavaScript(`(function () {
  if (window.__cindyMermaidExportPng) {
    window.__cindyMermaidExportPng(${JSON.stringify(id)}, ${EXPORT_PNG_SCALE});
  } else if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mermaid-export', id: ${JSON.stringify(id)}, ok: false, error: 'not-ready' }));
  }
})(); true;`);
      });
    },
  }), []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!active) return;
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return; // 非本协议回包忽略
    }
    if (
      typeof message !== 'object' || message === null
      || (message as { type?: unknown }).type !== 'mermaid-export'
    ) return;
    const { id, ok, base64, error } = message as {
      id?: unknown; ok?: unknown; base64?: unknown; error?: unknown;
    };
    if (typeof id !== 'string') return;
    const pending = pendingExportsRef.current.get(id);
    if (!pending) return; // 超时后迟到的回包丢弃
    pendingExportsRef.current.delete(id);
    clearTimeout(pending.timer);
    if (ok === true && typeof base64 === 'string' && base64.length > 0) {
      pending.resolve(base64);
    } else {
      pending.reject(new Error(typeof error === 'string' && error ? error : 'mermaid export failed'));
    }
  }, [active]);

  // 卸载时清空信箱:不兜底的话 exportPng promise 永不 settle。
  useEffect(() => () => {
    for (const pending of pendingExportsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('mermaid webview unmounted'));
    }
    pendingExportsRef.current.clear();
  }, [active, source]);

  // 构建完整 HTML 非平凡字符串工作——memo 掉,只有源码或主题变化才重建,
  // 父级无关重渲染不重付。
  const html = useMemo(
    () => {
      if (!active) return '';
      return buildMermaidWebViewHtml(source, {
        surfaceChip: colors.surfaceChip,
        textPrimary: colors.textPrimary,
        textSecondary: colors.textSecondary,
        textTertiary: colors.textTertiary,
        dark: mode === 'dark',
        deferSource,
        zoomable,
      });
    },
    [active, source, colors.surfaceChip, colors.textPrimary, colors.textSecondary, colors.textTertiary, mode, deferSource, zoomable],
  );
  return (
    // 尺寸必须钉在容器上(height 或 flex:1)、WebView 用 flex:1 填满:
    // react-native-webview 自带 flex:1(flexBasis 0),把 height 写在 WebView 自己
    // 身上时,容器(auto 高度)在 Modal 的 flex 父链下会被 Yoga 折叠成 0 高
    // (iOS 详情页图表区空白的根因);内联的 auto 卡片父链恰好不触发,
    // 靠父链形态兜底不可靠。
    <View
      style={[
        bare ? styles.containerBare : styles.container,
        fill ? styles.containerFill : { height },
      ]}
      testID={testID}
    >
      {active ? <WebView
        automaticallyAdjustContentInsets={false}
        javaScriptEnabled
        nestedScrollEnabled
        onMessage={handleMessage}
        originWhitelist={['*']}
        ref={webViewRef}
        scrollEnabled
        setSupportMultipleWindows={false}
        source={{
          html,
          baseUrl: 'https://xdt-maker-mobile.local',
        }}
        style={styles.webView}
      /> : null}
    </View>
  );
});

/**
 * 把导出的 PNG(base64)写进系统 cache 区的一次性临时文件,返回可分享的 file uri。
 * 契约同 downloadRemoteMediaShareTemp:只服务本次分享,OS 低存储统一回收,
 * 失败返回 null 由调用方兜底提示。base64 解码交给 legacy writeAsStringAsync
 * 原生完成(新 File API 只收 string/Uint8Array,JS 手动 atob 大图纯浪费)。
 */
export async function writeMermaidExportPngTemp(base64: string): Promise<string | null> {
  try {
    const dir = new Directory(Paths.cache, EXPORT_TMP_DIR_NAME);
    dir.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const file = new File(dir, `chart-${unique}.png`);
    const FileSystem = await import('expo-file-system/legacy');
    await FileSystem.writeAsStringAsync(file.uri, base64, { encoding: FileSystem.EncodingType.Base64 });
    return (file.size ?? 0) > 0 ? file.uri : null;
  } catch {
    return null;
  }
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // 沉浸式全屏形态:无边框无圆角,图表铺到屏幕边缘。
  containerBare: {
    backgroundColor: colors.surfaceChip,
    overflow: 'hidden',
  },
  containerFill: {
    alignSelf: 'stretch',
    flex: 1,
  },
  webView: {
    backgroundColor: colors.surfaceChip,
    flex: 1,
    width: '100%',
  },
});
