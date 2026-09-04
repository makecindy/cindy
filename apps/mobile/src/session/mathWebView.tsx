import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { buildMathWebViewHtml } from '@/session/mathWebViewHtml';
import { registerMobileMessageWebView } from '@/session/mobileMessageWebViewMetrics';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius } from '@/theme/tokens';

// 高度自适应的钳制范围:下限保住单行公式的可点/可读区,上限防止超长
// 多行公式撑爆消息列表(超出部分 WebView 自身可滚动)。
const MATH_WEBVIEW_MIN_HEIGHT = 44;
const MATH_WEBVIEW_MAX_HEIGHT = 320;
const MATH_WEBVIEW_DEFAULT_HEIGHT = MATH_WEBVIEW_MIN_HEIGHT + 16;

// 高度抖动阈值:小于该差值的上报不落地。公式渲染会产生多次相近的高度上报
// (源码首屏 → KaTeX 成形 → 字体就绪微调),逐次 setState 会连锁触发消息
// 列表重排 → 虚拟化重挂载 → WebView 重载归零 → 再上报……(模拟器实测的
// 整屏闪动循环)。滞回 + 高度缓存(下方)从机制上掐断这个循环。
const MATH_WEBVIEW_HEIGHT_EPSILON = 3;

// 已测量高度缓存(key = 公式源码):虚拟化滚动会反复卸载/重建公式 WebView,
// 重挂载时直接用上次量好的高度作为初始值——不再经历「占位高 → 实际高」的
// 布局跳变,滚回公式消息不抖、列表 contentSize 稳定。容量小上限 FIFO 淘汰,
// 只是会话内的热缓存,不追求持久化。
const measuredHeightCache = new Map<string, number>();
const MEASURED_HEIGHT_CACHE_CAP = 200;

function rememberMeasuredHeight(source: string, height: number): void {
  if (measuredHeightCache.size >= MEASURED_HEIGHT_CACHE_CAP && !measuredHeightCache.has(source)) {
    const oldest = measuredHeightCache.keys().next().value;
    if (oldest !== undefined) measuredHeightCache.delete(oldest);
  }
  measuredHeightCache.set(source, height);
}

/**
 * display LaTeX 公式块 —— WebView + KaTeX 渲染(固定本地资源,离线/非法
 * 公式在 WebView 内降级为源码文本)。高度由页面内脚本 postMessage 上报,
 * 组件按内容自适应;高度经滞回过滤 + 按公式源码缓存,保证消息列表布局稳定
 * (稳定性约束见上方常量注释,改动前先理解闪动循环的成因)。
 */
export function MathFormulaWebView({
  active = true,
  source,
  testID,
}: {
  active?: boolean;
  source: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const renderIdentityRef = useRef({ active, source });
  const renderGenerationRef = useRef(0);
  if (
    renderIdentityRef.current.active !== active
    || renderIdentityRef.current.source !== source
  ) {
    renderIdentityRef.current = { active, source };
    renderGenerationRef.current += 1;
  }
  const renderGeneration = renderGenerationRef.current;
  const [height, setHeight] = useState(
    () => measuredHeightCache.get(source) ?? MATH_WEBVIEW_DEFAULT_HEIGHT,
  );
  const heightRef = useRef(height);
  const katexHeightAppliedRef = useRef(false);
  useEffect(() => {
    const cachedHeight = measuredHeightCache.get(source);
    const nextHeight = cachedHeight ?? MATH_WEBVIEW_DEFAULT_HEIGHT;
    katexHeightAppliedRef.current = cachedHeight !== undefined;
    heightRef.current = nextHeight;
    setHeight((current) => current === nextHeight ? current : nextHeight);
  }, [source]);
  useEffect(() => {
    if (!active) return undefined;
    return registerMobileMessageWebView('math');
  }, [active]);
  const html = useMemo(
    () =>
      active
        ? buildMathWebViewHtml(source, {
            background: colors.surface,
            textPrimary: colors.textPrimary,
            textSecondary: colors.textSecondary,
          })
        : '',
    [active, colors.surface, colors.textPrimary, colors.textSecondary, source],
  );
  // 本次挂载是否已应用过 KaTeX 最终态高度:应用过之后,迟到的过渡态上报
  // (乱序消息)不允许再把高度拉回去。
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    if (!active || renderGenerationRef.current !== renderGeneration) return;
    // 消息门:只认页面脚本上报的 math-height 形态,其它一律忽略
    // (WebView 消息通道是不可信输入,不做任何超出高度设置的行为)。
    try {
      const payload = JSON.parse(event.nativeEvent.data) as {
        kind?: string;
        stage?: string;
        height?: number;
      };
      if (payload.kind !== 'math-height' || typeof payload.height !== 'number') return;
      if (!Number.isFinite(payload.height) || payload.height <= 0) return;
      const isFinalStage = payload.stage === 'katex';
      // 过渡态(源码占位)高度只在「既无最终高度缓存、本次挂载也还没等到
      // KaTeX 高度」时落地:重访已渲染过的公式直接保持缓存高度,消掉
      // 「缓存高 → 源码低 → 成品高」的高低跳动。
      if (!isFinalStage && (measuredHeightCache.has(source) || katexHeightAppliedRef.current)) {
        return;
      }
      const next = Math.min(
        Math.max(Math.ceil(payload.height), MATH_WEBVIEW_MIN_HEIGHT),
        MATH_WEBVIEW_MAX_HEIGHT,
      );
      if (isFinalStage) {
        katexHeightAppliedRef.current = true;
        // 只有最终态高度进缓存:过渡态高度是加载中间产物,缓存它会让下次
        // 重访以错误的初始高度起步。
        rememberMeasuredHeight(source, next);
      }
      if (Math.abs(next - heightRef.current) < MATH_WEBVIEW_HEIGHT_EPSILON) return;
      heightRef.current = next;
      setHeight(next);
    } catch {
      // 非 JSON 消息不属于本组件协议,忽略。
    }
  }, [active, renderGeneration, source]);
  return (
    <View style={[styles.container, { height }]} testID={testID}>
      {active ? <WebView
        automaticallyAdjustContentInsets={false}
        javaScriptEnabled
        nestedScrollEnabled
        onMessage={onMessage}
        originWhitelist={['*']}
        scrollEnabled
        setSupportMultipleWindows={false}
        source={{
          html,
          baseUrl: 'https://xdt-maker-mobile.local',
        }}
        // backgroundColor transparent → RNW 关掉 WKWebView 的 opaque,首帧
        // 提交前透出容器的 surface 底色,消掉默认白底闪一下的空白帧(规则 7)。
        style={[styles.webView, { height }]}
      /> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.container,
    overflow: 'hidden',
  },
  webView: {
    backgroundColor: 'transparent',
    width: '100%',
  },
});
