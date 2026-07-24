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
import { selectionQuoteMenuLabel } from '@/session/selectionQuote';
import { lineHeight, useTheme } from '@/theme';
import { typeScale } from '@/theme/tokens';

export function MarkdownFileReader({
  markdown,
  onQuoteSelection,
  targetLine,
  testID,
}: {
  markdown: string;
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
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    mutedColor: colors.textSecondary,
    textColor: colors.textPrimary,
    ...(targetLine ? { targetLine } : {}),
  }), [colors.border, colors.surfaceChip, colors.textPrimary, colors.textSecondary, markdown, targetLine]);

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

  return (
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
