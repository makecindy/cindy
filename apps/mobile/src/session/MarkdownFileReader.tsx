/**
 * 全屏 markdown 阅读器(文件预览的「渲染态」)。
 *
 * 复用聊天消息同款 HTML 构建器 buildSelectableMarkdownHtml(标题/列表/表格/
 * 代码块/图片与聊天观感一致),但与消息气泡的 SelectableMarkdownWebView 是
 * 两种载体:这里 WebView 自身滚动(flex:1),不做测高/揭开门——文档可能几
 * 千 px 高,气泡那套"整块撑高嵌进列表"的模型在全屏阅读场景既无必要也费内存。
 * 链接点击一律拦截转系统浏览器;mermaid 以代码块形态显示(渲染成图留二期)。
 *
 * chat-text-quote:传入 onQuoteSelection 时,经 WebView 原生 `menuItems` 在
 * 系统文字选择菜单里插入「添加到对话」项(与聊天流 UITextView 的菜单项同款
 * 交互;iOS / Android 双端原生支持),点按经 onCustomMenuSelection 带回
 * selectedText,由预览页写进 chatQuoteStore(带当前文件相对路径)。不用自绘
 * 浮动按钮——真机实测浮层与系统选择菜单撞位。
 */
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { selectionQuoteMenuLabel } from '@/session/selectionQuote';
import { lineHeight, useTheme } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

const PAGER_PAN_ACTIVE_X = 16;
const PAGER_PAN_FAIL_Y = 8;
const PAGER_SWIPE_DISTANCE = 56;
const PAGER_SWIPE_VELOCITY = 500;

export function MarkdownFileReader({
  markdown,
  onPageSwipe,
  onQuoteSelection,
  targetLine,
  testID,
}: {
  markdown: string;
  /** 由文件预览 pager 消费的明确横向翻页；纵向移动会让该手势失败给 WebView。 */
  onPageSwipe?: (direction: 'previous' | 'next') => void;
  /** chat-text-quote:系统菜单「添加到对话」的采集回调;未传时不加菜单项。 */
  onQuoteSelection?: (text: string) => void;
  /** 定位到源码行(1-based):加载后滚到覆盖该行的块并闪两下高亮(不驻留)。 */
  targetLine?: number | null;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const quoteEnabled = !!onQuoteSelection;
  // 菜单项在渲染时构造(而非模块常量):label 走 i18n;依赖 t 使语言切换后随重渲更新。
  const quoteMenuItems = useMemo(
    () => [{ key: 'xdtQuote', label: selectionQuoteMenuLabel() }],
    [t],
  );
  const html = useMemo(() => buildSelectableMarkdownHtml(markdown, {
    borderColor: colors.border,
    chipColor: colors.surfaceChip,
    inlineCodeColor: colors.chatInlineCodeText,
    fontSize: typeScale.body,
    // 与文件预览源码 FlatList 的 codeContent 对齐。
    horizontalPadding: spacing.lg,
    // body(16/22)行高比 1.375,低于 DESIGN.md §3 正文区间 1.43–1.56 下限;
    // 文档阅读是长文连续阅读场景,换 bodyRelaxed(16/24)= 1.50 落到规范值。
    // 字号不动:16 = DESIGN.md 的 Body 档。
    lineHeight: lineHeight.bodyRelaxed,
    mutedColor: colors.textSecondary,
    // 代码块语法着色随主题走(WebView 里没有 theme context,只能显式注入)。
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
  }), [colors, markdown, targetLine]);

  // 回调走 ref:onQuoteSelection 引用变化(页面重渲)不应重建 handler,
  // 更不应让 WebView 重载。
  const onQuoteSelectionRef = useRef(onQuoteSelection);
  onQuoteSelectionRef.current = onQuoteSelection;
  const handleCustomMenuSelection = useCallback((event: {
    nativeEvent: { label: string; key: string; selectedText: string };
  }) => {
    if (event.nativeEvent.key !== 'xdtQuote') return;
    const text = event.nativeEvent.selectedText;
    if (text && text.trim().length > 0) onQuoteSelectionRef.current?.(text);
  }, []);

  // WebView 会在 Android 原生层先接住任何方向的 touch；CSS 无法把轻微横偏
  // 还给外层 pager。此识别器仅在近似纯横向时激活，纵向一超过 8px 就失败，
  // 由 WebView 保持与源码 FlatList 相同的连续纵向滚动。
  const pagerPan = useMemo(() => Gesture.Pan()
    .activeOffsetX([-PAGER_PAN_ACTIVE_X, PAGER_PAN_ACTIVE_X])
    .failOffsetY([-PAGER_PAN_FAIL_Y, PAGER_PAN_FAIL_Y])
    .runOnJS(true)
    .onEnd((event) => {
      const isPageSwipe = Math.abs(event.translationX) >= PAGER_SWIPE_DISTANCE
        || Math.abs(event.velocityX) >= PAGER_SWIPE_VELOCITY;
      if (!isPageSwipe) return;
      onPageSwipe?.(event.translationX < 0 ? 'next' : 'previous');
    }), [onPageSwipe]);

  return (
    <GestureDetector gesture={pagerPan}>
      <View style={styles.fill} testID={testID}>
      <WebView
        menuItems={quoteEnabled ? quoteMenuItems : undefined}
        onCustomMenuSelection={quoteEnabled ? handleCustomMenuSelection : undefined}
        onShouldStartLoadWithRequest={interceptNavigation}
        originWhitelist={['about:blank']}
        scrollEnabled
        source={{ html }}
        style={[styles.fill, { backgroundColor: 'transparent' }]}
      />
      </View>
    </GestureDetector>
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
