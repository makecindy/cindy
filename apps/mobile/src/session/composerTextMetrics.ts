/**
 * Composer 文本度量 —— 输入框本体与语音听写覆盖层的**唯一**来源。
 *
 * 为什么必须集中:一段草稿文字在同一个 composer 里可能由三个渲染器画出来——
 * 1. 新建会话页的原生 `TextInput`;
 * 2. 会话页的 WebView 富文本编辑器(`composerRichInputHtml` 的 CSS);
 * 3. 语音听写期间盖在上面的草稿覆盖层(`Text` + absoluteFill)。
 *
 * 输入区可视高度由 1/2 的内容高度撑起,3 只是展示层(overflow hidden)。字号、行高或
 * 水平内边距任一处不同,同一段文字的换行位置就不同:覆盖层先换行时新起的那行落在框外
 * 被裁掉(表现为「说到第二行看不到新内容,要等输入框也换行才补出来」),反向则露出空行;
 * 内边距不同还会让听写与非听写的文字左右错位。
 *
 * 2026-07 收敛前这三处分别是 14/20、15/22(CSS 字面量)、16/22,且 WebView 无水平内边距。
 * 新增消费方一律引用本文件,不要各自写档位;本文件刻意不依赖 react-native,便于 WebView
 * HTML 生成器与 node 环境单测直接 import。
 */
import { lineHeight, spacing, typeScale } from '@/theme/tokens';

/** 输入文本字号(排版阶梯 typeScale.code)。 */
export const COMPOSER_TEXT_FONT_SIZE = typeScale.code;
/**
 * 单行文字的行高(排版阶梯 lineHeight.body),**不含内边距**;
 * 也是 COMPOSER_SINGLE_LINE_HEIGHT 的基数(见下)。
 */
export const COMPOSER_TEXT_LINE_HEIGHT = lineHeight.body;
/** 输入文本左右内边距:三个渲染器必须一致,否则听写与非听写的文字左右错位。 */
export const COMPOSER_TEXT_HORIZONTAL_PADDING = spacing.xs;
/** 输入文本上下内边距总量的一半；盒高计算仍保持上下合计 6pt。 */
export const COMPOSER_TEXT_VERTICAL_PADDING = 3;
/**
 * iOS 字形在 15/22 行框里的视觉中心比几何中心高约 3pt。Android 的
 * includeFontPadding 默认值不同,不能直接复用这个偏移；调用方应通过
 * composerTextPaddingForPlatform 取对应平台的上下值。
 */
export const COMPOSER_TEXT_OPTICAL_OFFSET_Y = 3;

export type ComposerTextPlatform = 'ios' | 'android' | 'default';

export interface ComposerTextPadding {
  bottom: number;
  top: number;
}

export function composerTextPaddingForPlatform(
  platform: ComposerTextPlatform,
  options: { optical?: boolean } = {},
): ComposerTextPadding {
  const opticalOffset = options.optical !== false && platform === 'ios'
    ? COMPOSER_TEXT_OPTICAL_OFFSET_Y
    : 0;
  return {
    bottom: COMPOSER_TEXT_VERTICAL_PADDING - opticalOffset,
    top: COMPOSER_TEXT_VERTICAL_PADDING + opticalOffset,
  };
}

/** 收起单行与 34pt + / 麦克风并排时用几何居中，不再做 iOS 光学下移。 */
export const COMPOSER_TEXT_GEOMETRIC_PADDING = composerTextPaddingForPlatform('default');

// Node-side consumers and the existing iOS WebView tests use iOS as the
// canonical reference. React Native consumers import the platform adapter.
const iosComposerTextPadding = composerTextPaddingForPlatform('ios');
export const COMPOSER_TEXT_PADDING_TOP = iosComposerTextPadding.top;
export const COMPOSER_TEXT_PADDING_BOTTOM = iosComposerTextPadding.bottom;

/** 单行输入区的可视高度 = 单行行高 + 上下内边距;原生输入框与 WebView 编辑器同源。 */
export const COMPOSER_SINGLE_LINE_HEIGHT =
  COMPOSER_TEXT_LINE_HEIGHT + COMPOSER_TEXT_PADDING_TOP + COMPOSER_TEXT_PADDING_BOTTOM;

/** RN 样式片段:`...COMPOSER_TEXT_STYLE` 一次展开字号 + 行高,不给漂移留缝。 */
export const COMPOSER_TEXT_STYLE = {
  fontSize: COMPOSER_TEXT_FONT_SIZE,
  lineHeight: COMPOSER_TEXT_LINE_HEIGHT,
};
