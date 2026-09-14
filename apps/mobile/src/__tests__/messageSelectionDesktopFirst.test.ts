import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 消息文本选择契约(2026-07 起):
// - 列表内所有消息正文一律原生 markdown 渲染,不再"每条完成消息挂一个选择 WebView"
//   (旧方案冷开 ~80 个 WebView 同时挂载,是内存 / 首屏 / 滚动的最大热点)。
// - 文本选择 = 完成态消息各块 Text 原生 selectable:长按文字就地弹系统选择手柄/Copy 菜单,
//   不跳转界面;整条复制走操作条按钮。选择按块进行(原生 Text 能力边界)。
// - 气泡必须是纯 View:挂 Pressable 会参与触摸协商,干扰正文里表格/代码块横向 ScrollView 的拖动。
describe('mobile message text selection', () => {
  it('renders message bodies natively with in-place per-block selectable text', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const flowSource = readFileSync(resolve(process.cwd(), 'e2e/maestro/message_selection.yaml'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);
    const markdownBodyStart = source.indexOf('function MarkdownBody');
    const markdownBodyEnd = source.indexOf('function renderInline', markdownBodyStart);
    const markdownBodySource = source.slice(markdownBodyStart, markdownBodyEnd);

    // 完成态才可选中;正文与 secondaryBody 都走原生 selectable。
    expect(source).toContain('const canSelectVisibleText = canUseCompletedActions && copyText.trim().length > 0;');
    expect(bubbleSource).toContain('selectable={canSelectVisibleText}');
    expect(bubbleSource).toContain('<MarkdownSelectableText selectable={canSelectVisibleText} style={styles.detailText}>');

    // iOS 部分选择:RN Text 底层是 UILabel 只能整块拷贝(facebook/react-native#13938),
    // 可选中块在 iOS 换用 react-native-uitextview(真 UITextView,系统选择手柄);
    // Android 维持 AppText selectable(本身有手柄)。嵌套 span 必须同为 UITextView 家族。
    expect(source).toContain("from 'react-native-uitextview'");
    expect(source).toContain('function MarkdownSelectableText({');
    expect(source).toContain("if (selectable && allowIosUITextView && Platform.OS === 'ios') {");
    expect(source).toContain('uiTextView');
    expect(source).toContain('function MarkdownSelectableSpan(');
    expect(source).toContain('const SpanText = ctx.SpanText ?? Text;');
    expect(markdownBodySource).toContain('blockSelectable && allowIosUITextView && Platform.OS === \'ios\'');

    // 气泡是纯 View,不挂 Pressable/onLongPress(避免干扰横向 ScrollView 手势)。
    expect(bubbleSource).not.toContain('<Pressable');
    expect(bubbleSource).not.toContain('onLongPress');

    // 列表内正文只有原生渲染路径:无选择 WebView、无全屏选择查看器。
    expect(markdownBodySource).toContain('testID="message.markdownBody"');
    // Agent 回复二次测宽:stretch 量到像素宽后钉死,避免 UITextView 首帧偏矮被列表裁切。
    expect(markdownBodySource).toContain('nextSettledContentWidth');
    expect(markdownBodySource).toContain('collapsable={false}');
    expect(markdownBodySource).toContain('onLayout={handleSettledWidthLayout}');
    expect(markdownBodySource).toContain('pinContentWidth');
    expect(markdownBodySource).toContain('pinSettledWidth');
    expect(markdownBodySource).toContain("pinContentWidth ? { alignSelf: 'stretch' } : null");
    expect(markdownBodySource).toContain(
      'style={pinSettledWidth ? { width: contentWidth, maxWidth: \'100%\' } : null}',
    );
    expect(markdownBodySource).toContain(
      "key={`${group.key}:${pinSettledWidth ? contentWidth : 'hug'}`}",
    );
    expect(markdownBodySource).not.toContain('SelectableMarkdownWebView');
    expect(source).not.toContain('SelectableMarkdownWebView');
    expect(source).not.toContain('MessageTextSelectionModal');
    expect(source).not.toContain('InlineSelectableMessageText');

    // 各块 Text 开原生选中,含内嵌图片 View 的块除外(Android 上 selectable+内嵌 View 有风险)。
    expect(markdownBodySource).toContain('const inlinesSelectable = useCallback((inlines: readonly MobileMarkdownInline[]) => (');
    expect(markdownBodySource).toContain("inline.type === 'image' && isMobileMarkdownImageDirectUrl(inline.url)");
    expect(markdownBodySource).toContain('selectable={inlinesSelectable(block.inlines)}');

    // 跨段选择:连续纯文本块合并进同一个原生文本视图(text_run),原生选择手柄可横跨段落。
    // Android 上长 selectable Text 分块,避免单个超高原生文本视图干扰列表测高/滚动。
    expect(markdownBodySource).toContain('ANDROID_SELECTABLE_TEXT_RUN_GROUPING_OPTIONS');
    expect(markdownBodySource).toContain("const textRunGroupingOptions = Platform.OS === 'android'");
    expect(markdownBodySource).not.toContain("selectable === true && Platform.OS === 'android'");
    expect(markdownBodySource).toContain('groupMobileMarkdownSelectableBlocks(blocks, textRunGroupingOptions)');
    expect(markdownBodySource).toContain('testID="message.markdownTextRun"');
    expect(markdownBodySource).toContain("lineHeight: layout.markdownBodyGap");
    expect(markdownBodySource).toContain('!block.textRunContinuation');
    expect(markdownBodySource).toContain('isTextRunContinuationGroup(group)');
    expect(markdownBodySource).toContain('height: layout.markdownBodyGap');
    expect(markdownBodySource).not.toContain('{ gap: layout.markdownBodyGap }');
    expect(source).toContain('mobileMarkdownImageAltChipText(inline.alt)');
    expect(markdownBodySource).toContain('selectable={inlinesSelectable(cell)}');
    expect(markdownBodySource).toContain('selectable={selectable === true}');

    // WebView 独有的用户气泡宽度估算 hack 不复活(原生 Text 自适应宽度)。
    expect(source).not.toContain('estimateSelectableUserBubbleWidth');

    // 列表滚动不被选择态钳制(原生选择手柄由系统处理,与列表滚动无关)。
    expect(source).not.toContain('scrollEnabled={!textSelectionActive}');

    // e2e 流程与新交互对齐:长按正文文字 → 系统选择菜单 → Copy。
    expect(flowSource).toContain('id: "message.markdownBody"');
    expect(flowSource).toContain('visible: "Copy"');
    expect(flowSource).toContain('- tapOn: "Copy"');
    expect(flowSource).not.toContain('message.textSelectionModal');
    expect(flowSource).not.toContain('message.selectableMarkdownBody');
  });
});
