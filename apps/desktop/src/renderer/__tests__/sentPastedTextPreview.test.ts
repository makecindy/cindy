/**
 * sentPastedTextPreview.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for issue #946:「粘贴大量日志后内容被静默截断，未收到任何提示」。
 *
 * 实测结论:发送链路并没有截断(agent 能报出 440 行粘贴文本的末行内容),真正的缺陷
 * 在已发送气泡的渲染上 ——
 *   1. 粘贴段胶囊没有 onClick,全文只挂在 320×256 的 hover tooltip 上,几百行日志
 *      读不了也复制不了,用户无法核对自己发出去的内容;
 *   2. 收起态按原文纯文本裁到 10 行、展开态换成一个胶囊,「展开」反而看得更少。
 *
 * 契约:
 *   P1  projectSentPastedPlainText 把粘贴段折叠成胶囊文案,周围手打文字原样保留。
 *   P2  range 缺失 / 越界时退化为原文,绝不截断(宁可不折叠)。
 *   P3  「只粘一段」的消息投影后不再撞收起阈值 —— 不套第二层收起。
 *   S1  粘贴段胶囊接 onClick → handlePastedTextChipClick(hover tooltip 不再是唯一出口)。
 *   S2  ToolPayloadLightbox 以 kind:'text' 挂载且不传 textEdit(已发送消息只读)。
 *   S3  测量镜像与收起态渲染共用 collapseMeasureBody(同一份投影,判定与呈现一致)。
 *   S4  previewTitle 在四种界面语言里都有,标题不复用随消息落库的 display。
 *
 * 组件级契约走静态源码扫描,与 textLightbox.test.ts / imageLightboxCloseAnywhere.test.ts
 * 同一约定:把测试留在 node 环境,不为这几条接线检查拖进 jsdom + react-dom。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { projectSentPastedPlainText } from '@/components/chat/UserMessage';
import {
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
} from '@/components/chat/userMessageCollapse';
import type { PastedTextRange } from '@/lib/imageRef';

const sourcePath = resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx');
const source = readFileSync(sourcePath, 'utf8');

const LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;

/** 440 行日志的最小可测替身:行数足够撞穿收起阈值。 */
function makeLog(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `2026-07-29 log line ${i + 1}`).join('\n');
}

describe('projectSentPastedPlainText', () => {
  it('P1 把粘贴段折叠成胶囊文案,前后手打文字原样保留', () => {
    const log = makeLog(440);
    const content = `帮我看这段日志\n${log}\n有什么问题`;
    const start = content.indexOf(log);
    const ranges: PastedTextRange[] = [
      { start, end: start + log.length, display: '粘贴的文本(440 行)' },
    ];

    expect(projectSentPastedPlainText(content, ranges)).toBe(
      '帮我看这段日志\n粘贴的文本(440 行)\n有什么问题',
    );
  });

  it('P1 多段粘贴各自折叠成自己的胶囊文案', () => {
    const first = makeLog(30);
    const second = makeLog(40);
    const content = `A\n${first}\nB\n${second}\nC`;
    const firstStart = content.indexOf(first);
    const secondStart = content.indexOf(second, firstStart + first.length);
    const ranges: PastedTextRange[] = [
      { start: firstStart, end: firstStart + first.length, display: '粘贴的文本(30 行)' },
      { start: secondStart, end: secondStart + second.length, display: '粘贴的文本(40 行)' },
    ];

    expect(projectSentPastedPlainText(content, ranges)).toBe(
      'A\n粘贴的文本(30 行)\nB\n粘贴的文本(40 行)\nC',
    );
  });

  it('P2 没有 range 时原样返回', () => {
    const content = makeLog(440);
    expect(projectSentPastedPlainText(content)).toBe(content);
    expect(projectSentPastedPlainText(content, [])).toBe(content);
  });

  it('P2 range 越界 / 逆序时退化为原文,不截断', () => {
    const content = '帮我看这段日志';
    // 越界(end 超出正文长度)——偏移不可信时宁可不折叠,也不能吞掉尾部内容。
    expect(
      projectSentPastedPlainText(content, [
        { start: 2, end: content.length + 50, display: '粘贴的文本(440 行)' },
      ]),
    ).toBe(content);
    // 逆序 / 空区间同样被丢弃。
    expect(
      projectSentPastedPlainText(content, [{ start: 5, end: 3, display: '粘贴的文本(2 行)' }]),
    ).toBe(content);
  });

  it('P3 只粘一段的消息投影后不再撞收起阈值(不套第二层收起)', () => {
    const log = makeLog(440);
    const content = `看下这段日志\n${log}`;
    const start = content.indexOf(log);
    const ranges: PastedTextRange[] = [
      { start, end: start + log.length, display: '粘贴的文本(440 行)' },
    ];

    // 修复前:拿原文测量,440 行必然收起 → 收起看 10 行原文、展开只剩胶囊。
    expect(mayExceedVisualLineThreshold(content, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD)).toBe(
      true,
    );
    // 修复后:按胶囊文案测量,整条消息只有两行,直接以胶囊呈现。
    expect(
      mayExceedVisualLineThreshold(
        projectSentPastedPlainText(content, ranges),
        LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
      ),
    ).toBe(false);
  });

  it('P3 手打正文本身够长时仍然收起(投影只抵扣被折叠的粘贴段)', () => {
    const typed = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行手打说明`).join('\n');
    const log = makeLog(200);
    const content = `${typed}\n${log}`;
    const start = content.indexOf(log);
    const ranges: PastedTextRange[] = [
      { start, end: start + log.length, display: '粘贴的文本(200 行)' },
    ];

    expect(
      mayExceedVisualLineThreshold(
        projectSentPastedPlainText(content, ranges),
        LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
      ),
    ).toBe(true);
  });
});

describe('UserMessage pasted-text chip wiring', () => {
  it('S1 粘贴段胶囊接上 onClick,hover tooltip 不再是查看全文的唯一出口', () => {
    const chipBlock = source.slice(
      source.indexOf("if (token.kind === 'pasted')"),
      source.indexOf("if (token.kind === 'pasted')") + 1200,
    );
    expect(chipBlock).toContain('onPastedTextChipClick');
    expect(chipBlock).toContain('onClick:');
    expect(chipBlock).toContain('event.currentTarget');
    // 两个 renderContent 调用点(引用交错分段 / 普通正文)都要传,少传一处
    // 那条路径上的粘贴段就又变回不可点。召唤卡 prompt 插槽已随「卡片即消息」
    // 合并形态一并取消(chip 标注行改版):$指令 正文回归气泡,由普通正文
    // 调用点统一渲染,不再有第三个调用点。
    expect(source.match(/handlePastedTextChipClick,/g)?.length).toBe(2);
  });

  it('S1b 两个调用点都拿到同一份 sessionReferences(不再有 undefined 占位)', () => {
    // 召唤卡 prompt 曾经漏传 sessionReferences(PR #966 review);该插槽现已
    // 随合并形态取消,$指令 正文并入普通正文调用点。sessionReferences 按
    // sessionId / messageClientId 匹配、不依赖文本偏移,两处理应拿同一份。
    // 调用点的末两个实参恒为 `sessionReferences, handlePastedTextChipClick`,
    // 一并锁住"都可点"与"都有引用元数据"。
    expect(
      source.match(/sessionReferences,\s*\n\s*handlePastedTextChipClick,/g)?.length,
    ).toBe(2);
  });

  it('S2 ToolPayloadLightbox 以只读 text 模式挂载', () => {
    const lightboxStart = source.indexOf('{pastedTextPreview !== null && (');
    expect(lightboxStart).toBeGreaterThan(-1);
    const lightboxBlock = source.slice(lightboxStart, lightboxStart + 600);
    expect(lightboxBlock).toContain('<ToolPayloadLightbox');
    expect(lightboxBlock).toContain("kind: 'text'");
    expect(lightboxBlock).toContain("t('newChat.pastedText.previewTitle')");
    expect(lightboxBlock).toContain('triggerRef={activeFileChipRef}');
    // 已发送消息不可编辑:textEdit 一旦传入,lightbox 会渲染保存按钮。
    expect(lightboxBlock).not.toContain('textEdit');
  });

  it('S3 测量镜像与收起态渲染共用同一份投影正文', () => {
    expect(source).toContain('mayExceedVisualLineThreshold(collapseMeasureBody, collapseThreshold)');
    expect(source).toContain(
      'useUserMessageAutoCollapse(collapseMeasureBody, collapseMeasureEnabled, collapseThreshold)',
    );
    // 测量镜像(独立 JSX 表达式)。
    expect(source.match(/\{collapseMeasureBody\}/g)?.length).toBe(1);
    // 收起态正文(三元分支里,不是独立表达式)。
    expect(source).toMatch(/longMessageCollapsed\s*\n?\s*\?[\s\S]{0,400}collapseMeasureBody/);
    // 偏移只在 bubbleBody 与 ghostBody 同源时才折叠(引用交错的消息保持原文测量)。
    expect(source).toContain('bubbleBody === ghostBody');
  });

  it('S4 previewTitle 在四种界面语言里都有', () => {
    for (const locale of LOCALES) {
      const localePath = resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json');
      const parsed = JSON.parse(readFileSync(localePath, 'utf8')) as {
        newChat: { pastedText: { previewTitle?: string } };
      };
      expect(parsed.newChat.pastedText.previewTitle, locale).toBeTruthy();
    }
  });
});
