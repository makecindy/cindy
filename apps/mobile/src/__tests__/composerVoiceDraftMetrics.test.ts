import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Composer 三个文本渲染器的度量一致性守护。
 *
 * 同一段草稿文字可能由三处画出来:新建会话页的原生 TextInput、会话页的 WebView 富文本
 * 编辑器、语音听写期间盖在上面的草稿覆盖层。前两者撑起输入区高度,第三者只是展示层。
 *
 * 背景(2026-07 修复):三处曾各写一份档位——原生 14/20(页面覆盖)、WebView CSS 字面
 * 15/22 且无水平内边距、听写层 16/22。后果是听写层提前一行换行,新起的那行落在框外被
 * overflow hidden 裁掉(说到第二行看不到新内容,要等输入框也换行才补出来),听写文字与
 * 非听写文字的字号、左右起点也明显不同。
 *
 * 因此字号 / 行高 / 内边距只许来自 composerTextMetrics 一个正本。
 */

const ROOT = process.cwd();
const METRICS = 'src/session/composerTextMetrics.ts';
const COMPOSER_ROW = 'src/session/MobileComposerInputRow.tsx';
const RICH_INPUT_HTML = 'src/session/composerRichInputHtml.ts';
const COMPOSER_PAGES = ['app/sessions/new.tsx', 'app/sessions/[sessionId].tsx'];
const DRAFT_TEXT_STYLES = ['voiceDraftText', 'voiceDraftListeningText'];

function read(rel: string): string {
  // 归一化换行:Windows checkout 是 CRLF,styleBlock 的 `\n  <name>:` 锚点会全部失配。
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 取 StyleSheet 里某个样式键的对象字面量内容（这些块内部没有嵌套对象）。
 * 锚定「行首两空格缩进」以命中样式表条目，不误吃同名的函数参数对象。
 */
function styleBlock(source: string, name: string): string {
  const match = new RegExp(`\\n {2}${name}:\\s*\\{([^}]*)\\}`).exec(source);
  expect(match, `未找到样式 ${name}`).not.toBeNull();
  return match![1];
}

describe('composer voice draft text metrics', () => {
  it('derives the shared composer metrics from the design tokens', () => {
    const source = read(METRICS);
    expect(source).toContain('export const COMPOSER_TEXT_FONT_SIZE = typeScale.code;');
    expect(source).toContain('export const COMPOSER_TEXT_LINE_HEIGHT = lineHeight.body;');
    expect(source).toContain('export const COMPOSER_TEXT_HORIZONTAL_PADDING = spacing.xs;');
    // WebView HTML 生成器与 node 单测都要 import 本文件,不能把 react-native 拖进来。
    expect(source).not.toMatch(/from 'react-native'/);
  });

  it('exposes the shared metrics as the composer row draft text style', () => {
    const source = read(COMPOSER_ROW);
    expect(source).toContain('export const MOBILE_COMPOSER_DRAFT_TEXT_STYLE = COMPOSER_TEXT_STYLE;');
    // 单行盒高与文本行高同源:「单行」必须正好装一行文字。
    expect(source).toContain('export const MOBILE_COMPOSER_INPUT_LINE_HEIGHT = COMPOSER_TEXT_LINE_HEIGHT;');
  });

  it('renders the real composer TextInput with the shared metrics', () => {
    const block = styleBlock(read(COMPOSER_ROW), 'input');
    expect(block).toContain('...COMPOSER_TEXT_STYLE');
    expect(block).toContain('paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING');
  });

  it('renders the WebView rich composer with the shared metrics instead of CSS literals', () => {
    const source = read(RICH_INPUT_HTML);
    expect(source).toContain('font-size: ${COMPOSER_TEXT_FONT_SIZE}px');
    expect(source).toContain('line-height: ${COMPOSER_TEXT_LINE_HEIGHT}px');
    expect(source).toContain('padding: ${COMPOSER_TEXT_VERTICAL_PADDING}px ${COMPOSER_TEXT_HORIZONTAL_PADDING}px');
    // #editor 的排版不得回退成字面量(CSS 不在 typographyTokenDiscipline 的扫描面内)。
    const editorBlock = /#editor \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(editorBlock).not.toMatch(/font-size:\s*\d/);
    expect(editorBlock).not.toMatch(/line-height:\s*\d/);
  });

  it('keeps every voice draft overlay text on the shared draft text style', () => {
    for (const rel of COMPOSER_PAGES) {
      const source = read(rel);
      for (const name of DRAFT_TEXT_STYLES) {
        const block = styleBlock(source, name);
        expect(block, `${rel} ${name} 必须复用输入框档位`).toContain('...MOBILE_COMPOSER_DRAFT_TEXT_STYLE');
        expect(block, `${rel} ${name} 不得自带字号 / 行高`).not.toMatch(/fontSize|lineHeight/);
      }
      const overlayContent = styleBlock(source, 'voiceDraftOverlayContent');
      expect(overlayContent, `${rel} 覆盖层水平内边距必须与输入框同源`)
        .toContain('paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING');
    }
  });

  /**
   * 听写期间「点输入区停止听写」的命中层盖在 inputFrame 上,单行时只有 28pt;
   * 触控目标要 ≥44pt(mobile-design-guide),且只能靠父容器撑起——RN 的 hitSlop
   * 不会越过父视图边界。两个页面都要撑,否则各自的听写停止都点不准。
   */
  it('raises the input frame to the touch target while dictating', () => {
    const row = read(COMPOSER_ROW);
    expect(row).toContain('export const MOBILE_COMPOSER_MIN_TOUCH_TARGET = 44;');
    // 显式 height 会压过 minHeight(manual 定高时 frameHeight 可能小于触控目标),
    // 数值高度必须先 clamp,否则命中区又被压回 28pt。
    expect(row).toContain('Math.max(inputFrameHeight, inputFrameMinHeight)');
    expect(row).toContain('resolvedInputFrameHeight != null && { height: resolvedInputFrameHeight }');
    for (const rel of COMPOSER_PAGES) {
      expect(read(rel), `${rel} 听写期间必须把输入区撑到触控目标`)
        .toContain('inputFrameMinHeight={voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}');
    }
  });

  it('forbids page-level font overrides on the composer input', () => {
    for (const rel of COMPOSER_PAGES) {
      expect(read(rel), `${rel} 不得再用页面样式覆盖输入框字号 / 行高`)
        .not.toContain('sessionComposerInput');
    }
  });
});
