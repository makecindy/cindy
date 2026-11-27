/**
 * 全屏 markdown 阅读器(文件预览的「渲染态」)。
 *
 * 复用聊天消息同款 HTML 构建器 buildSelectableMarkdownHtml(标题/列表/表格/
 * 代码块/图片与聊天观感一致),但与消息气泡的 SelectableMarkdownWebView 是
 * 两种载体:这里 WebView 自身滚动(flex:1),不做测高/揭开门——文档可能几
 * 千 px 高,气泡那套"整块撑高嵌进列表"的模型在全屏阅读场景既无必要也费内存。
 * 链接点击一律拦截转系统浏览器;图片通过渐进式 DOM 回填展示并支持点按进
 * 全屏 ImageLightbox。
 *
 * chat-text-quote:传入 onQuoteSelection 时,经 WebView 原生 `menuItems` 在
 * 系统文字选择菜单里插入「添加到对话」项(与聊天流 UITextView 的菜单项同款
 * 交互;iOS / Android 双端原生支持),点按经 onCustomMenuSelection 带回
 * selectedText,由预览页写进 chatQuoteStore(带当前文件相对路径)。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';
import {
  MARKDOWN_FILE_PAGER_SCRIPT,
  parseMarkdownImageOpen,
  parseMarkdownPageSwipe,
} from '@/session/markdownFilePager';
import type { MarkdownImageResolution } from '@/session/markdownDocumentImages';
import { selectionQuoteMenuLabel } from '@/session/selectionQuote';
import { useHtmlBrowserViewport } from '@/session/useHtmlBrowserViewport';
import type { BrowserInsets } from '@/session/htmlBrowserViewport';
import { lineHeight, useTheme } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

function buildImageHydrateJs(rawUrl: string, resolution: MarkdownImageResolution): string {
  const uri = resolution.status === 'ready' ? resolution.uri : '';
  return `window.__cindyUpdateMarkdownImage&&window.__cindyUpdateMarkdownImage(${JSON.stringify(rawUrl)},${JSON.stringify(uri)},${JSON.stringify(resolution.status)});true;`;
}

export function MarkdownFileReader({
  markdown,
  onPageSwipe,
  onImagePress,
  onQuoteSelection,
  resolvedImages,
  targetLine,
  testID,
  viewportInsets,
  imageSources,
}: {
  markdown: string;
  /** 由文件预览 pager 消费的明确横向翻页；纵向移动会让该手势失败给 WebView。 */
  onPageSwipe?: (direction: 'previous' | 'next') => void;
  /** 点按文档内任意图片 → 打开全屏 ImageLightbox(传出文档序 0-based 下标)。 */
  onImagePress?: (imageIndex: number) => void;
  /** chat-text-quote:系统菜单「添加到对话」的采集回调;未传时不加菜单项。 */
  onQuoteSelection?: (text: string) => void;
  /** 渐进式拉回的本地/远端图片(rawUrl → data: URI 或 error)，原地注入不重载 WebView。 */
  resolvedImages?: ReadonlyMap<string, MarkdownImageResolution>;
  /** 定位到源码行(1-based):加载后滚到覆盖该行的块并闪两下高亮(不驻留)。 */
  targetLine?: number | null;
  testID?: string;
  viewportInsets?: BrowserInsets;
  imageSources?: ReadonlyMap<string, { uri: string }>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { viewRef, measure, viewportStyle, obscuredContentInsets } = useHtmlBrowserViewport(
    viewportInsets ?? { top: 0, bottom: 0, left: 0, right: 0 },
  );
  const webViewRef = useRef<WebView>(null);
  const loadedRef = useRef(false);
  const appliedRef = useRef<Map<string, string>>(new Map());
  const resolvedImagesRef = useRef(resolvedImages);
  resolvedImagesRef.current = resolvedImages;
  const quoteEnabled = !!onQuoteSelection;
  const interactiveImages = Boolean(onImagePress && !imageSources);
  const quoteMenuItems = useMemo(
    () => [{ key: 'xdtQuote', label: selectionQuoteMenuLabel() }],
    [t],
  );
  const html = useMemo(() => buildSelectableMarkdownHtml(markdown, {
    ...(imageSources ? { imageSources } : {}),
    ...(interactiveImages ? { interactiveImages: true } : {}),
    borderColor: colors.border,
    chipColor: colors.surfaceChip,
    inlineCodeColor: colors.chatInlineCodeText,
    fontSize: typeScale.body,
    horizontalPadding: spacing.lg,
    lineHeight: lineHeight.bodyRelaxed,
    mutedColor: colors.textSecondary,
    syntaxColors: {
      comment: colors.syntaxComment,
      function: colors.syntaxFunction,
      keyword: colors.syntaxKeyword,
      number: colors.syntaxNumber,
      property: colors.syntaxProperty,
      string: colors.syntaxString,
    },
    textColor: colors.textPrimary,
    ...(targetLine ? { targetLine } : {}),
  }), [colors, imageSources, interactiveImages, markdown, targetLine]);

  const flushResolvedImages = useCallback((forceAll: boolean) => {
    const map = resolvedImagesRef.current;
    const webView = webViewRef.current;
    if (!map || !webView || !loadedRef.current) return;
    const chunks: string[] = [];
    for (const [rawUrl, resolution] of map.entries()) {
      const signature =
        resolution.status === 'ready'
          ? `ready:${resolution.uri.length}:${resolution.uri.slice(0, 32)}`
          : resolution.status;
      if (!forceAll && appliedRef.current.get(rawUrl) === signature) continue;
      appliedRef.current.set(rawUrl, signature);
      chunks.push(buildImageHydrateJs(rawUrl, resolution));
    }
    if (chunks.length > 0) {
      webView.injectJavaScript(chunks.join('\n'));
    }
  }, []);

  // Reset applied-hydration state whenever the HTML document itself changes.
  useEffect(() => {
    loadedRef.current = false;
    appliedRef.current.clear();
  }, [html]);

  useEffect(() => {
    flushResolvedImages(false);
  }, [flushResolvedImages, resolvedImages]);

  const handleLoadEnd = useCallback(() => {
    loadedRef.current = true;
    appliedRef.current.clear();
    flushResolvedImages(true);
  }, [flushResolvedImages]);

  const onQuoteSelectionRef = useRef(onQuoteSelection);
  onQuoteSelectionRef.current = onQuoteSelection;
  const handleCustomMenuSelection = useCallback((event: {
    nativeEvent: { label: string; key: string; selectedText: string };
  }) => {
    if (event.nativeEvent.key !== 'xdtQuote') return;
    const text = event.nativeEvent.selectedText;
    if (text && text.trim().length > 0) onQuoteSelectionRef.current?.(text);
  }, []);

  const onImagePressRef = useRef(onImagePress);
  onImagePressRef.current = onImagePress;
  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    const direction = parseMarkdownPageSwipe(event.nativeEvent.data);
    if (direction) {
      onPageSwipe?.(direction);
      return;
    }
    const imageIndex = parseMarkdownImageOpen(event.nativeEvent.data);
    if (imageIndex !== null) {
      onImagePressRef.current?.(imageIndex);
    }
  }, [onPageSwipe]);

  return (
    <View ref={viewRef} onLayout={measure} collapsable={false} style={[styles.fill, viewportStyle]} testID={testID}>
      <WebView
        ref={webViewRef}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        obscuredContentInsets={obscuredContentInsets}
        contentInset={obscuredContentInsets}
        injectedJavaScript={onPageSwipe ? MARKDOWN_FILE_PAGER_SCRIPT : undefined}
        onLoadEnd={interactiveImages ? handleLoadEnd : undefined}
        onMessage={onPageSwipe || onImagePress ? handleMessage : undefined}
        menuItems={quoteEnabled ? quoteMenuItems : undefined}
        onCustomMenuSelection={quoteEnabled ? handleCustomMenuSelection : undefined}
        onShouldStartLoadWithRequest={interceptNavigation}
        originWhitelist={['about:blank']}
        scrollEnabled
        source={{ html }}
        style={[styles.fill, { backgroundColor: 'transparent' }]}
      />
    </View>
  );
}

/** 静态 HTML 之外的任何导航(点链接)都拦下来交给系统浏览器。 */
function interceptNavigation(request: ShouldStartLoadRequest): boolean {
  const url = request.url ?? '';
  if (url === 'about:blank' || url.startsWith('about:')) return true;
  if (/^https?:\/\//i.test(url)) {
    void Linking.openURL(url).catch(() => undefined);
  }
  return false;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
