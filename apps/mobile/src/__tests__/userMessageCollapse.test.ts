import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PR_WATCH_EXPANDED_BLANK_FIXTURE } from '@/__tests__/fixtures/prWatchExpandedBlank';

import {
  AUTOMATION_USER_MESSAGE_COLLAPSED_LINES,
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_COLLAPSED_LINES,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  resolveUserMessageCollapse,
  shouldAutoCollapseUserMessageContent,
  truncateTextToVisualLines,
} from '@/session/userMessageCollapse';

describe('shouldAutoCollapseUserMessageContent (首帧估算)', () => {
  it('keeps short user messages expanded by default', () => {
    expect(shouldAutoCollapseUserMessageContent('帮我看一下最近的日志')).toBe(false);
    expect(shouldAutoCollapseUserMessageContent('   ')).toBe(false);
  });

  it('collapses content after the visual line threshold (short lines count as one each)', () => {
    const thresholdLines = Array.from(
      { length: LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD },
      (_, index) => `line ${index + 1}`,
    ).join('\n');
    const extraLine = `${thresholdLines}\nline ${LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1}`;

    expect(shouldAutoCollapseUserMessageContent(thresholdLines)).toBe(false);
    expect(shouldAutoCollapseUserMessageContent(extraLine)).toBe(true);
  });

  it('collapses CJK-dense scheduler prompts with few newlines', () => {
    const lines = Array.from(
      { length: 9 },
      (_, index) => `${index + 1}. ${'按规则处理并回复'.repeat(16)}`,
    ).join('\n');

    expect(lines.split('\n').length).toBeLessThan(LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD);
    expect(shouldAutoCollapseUserMessageContent(lines)).toBe(true);
  });
});

describe('自动化任务消息的更低阈值', () => {
  it('collapses automation prompts that a hand-typed message would keep expanded', () => {
    const sixLines = Array.from({ length: 6 }, (_, index) => `step ${index + 1}`).join('\n');

    expect(shouldAutoCollapseUserMessageContent(sixLines)).toBe(false);
    expect(
      shouldAutoCollapseUserMessageContent(sixLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(true);
    expect(mayExceedVisualLineThreshold(sixLines)).toBe(false);
    expect(
      mayExceedVisualLineThreshold(sixLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(true);
  });

  it('keeps short automation prompts expanded (threshold lines exactly)', () => {
    const thresholdLines = Array.from(
      { length: AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD },
      (_, index) => `step ${index + 1}`,
    ).join('\n');

    expect(
      shouldAutoCollapseUserMessageContent(thresholdLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(false);
  });

  it('automation tier stays strictly tighter than the hand-typed tier', () => {
    expect(AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD).toBeLessThan(
      LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
    );
    expect(AUTOMATION_USER_MESSAGE_COLLAPSED_LINES).toBeLessThan(
      LONG_USER_MESSAGE_COLLAPSED_LINES,
    );
  });
});

describe('mayExceedVisualLineThreshold (测量粗筛)', () => {
  it('skips measurement for content that cannot reach the threshold at any bubble width', () => {
    expect(mayExceedVisualLineThreshold('')).toBe(false);
    expect(mayExceedVisualLineThreshold('帮我看一下最近的日志')).toBe(false);
  });

  it('is an upper bound: never skips content the estimator would collapse', () => {
    const samples = [
      'x'.repeat(841),
      '改'.repeat(450),
      Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n'),
    ];
    for (const sample of samples) {
      expect(shouldAutoCollapseUserMessageContent(sample)).toBe(true);
      expect(mayExceedVisualLineThreshold(sample)).toBe(true);
    }
  });
});

describe('resolveUserMessageCollapse (实测优先,估算兜底)', () => {
  it('prefers measured line count over the estimator once available', () => {
    const longText = '改'.repeat(500);
    // 估算认为要收起,但实测只有阈值内行数(如平板宽气泡)→ 不收起。
    expect(shouldAutoCollapseUserMessageContent(longText)).toBe(true);
    expect(resolveUserMessageCollapse(longText, 10, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD)).toBe(false);
    // 实测超过阈值 → 收起,无论估算怎么说。
    expect(resolveUserMessageCollapse('short', 15, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD)).toBe(true);
  });

  it('falls back to the estimator before measurement arrives', () => {
    const longText = '改'.repeat(500);
    expect(resolveUserMessageCollapse(longText, null, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD)).toBe(true);
    expect(resolveUserMessageCollapse('短消息', null, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD)).toBe(false);
  });

  it('classifies the reported PR-watch Markdown as a collapsible long message', () => {
    expect(PR_WATCH_EXPANDED_BLANK_FIXTURE.split('\n').length)
      .toBeGreaterThan(LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD);
    expect(shouldAutoCollapseUserMessageContent(PR_WATCH_EXPANDED_BLANK_FIXTURE)).toBe(true);
    expect(mayExceedVisualLineThreshold(PR_WATCH_EXPANDED_BLANK_FIXTURE)).toBe(true);
    // 隐藏测量最多回报 threshold + 1 行;该哨兵值必须继续判长消息,
    // 从而让用户点「展开」时进入 RN Text fallback,不再挂超高 UITextView。
    expect(resolveUserMessageCollapse(
      PR_WATCH_EXPANDED_BLANK_FIXTURE,
      LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1,
      LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
    )).toBe(true);
  });
});

describe('truncateTextToVisualLines', () => {
  it('keeps only the visible line budget and drops later paragraphs', () => {
    expect(truncateTextToVisualLines('第一行\n第二行\n隐藏内容', 2)).toBe('第一行\n第二行');
  });
});

describe('MessageRenderer 长消息测量接线', () => {
  it('caps the invisible native text layout at one line past the collapse threshold', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const measureStart = source.indexOf('{collapseMeasureEnabled ? (');
    const measureEnd = source.indexOf('{shouldCollapseLongMessage ? (', measureStart);

    expect(measureStart).toBeGreaterThan(-1);
    expect(measureEnd).toBeGreaterThan(measureStart);
    expect(source.slice(measureStart, measureEnd)).toContain(
      'numberOfLines={collapseThreshold + 1}',
    );
  });

  it('falls back from the giant iOS UITextView only after a long message is expanded', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('allowIosUITextView={!shouldCollapseLongMessage}');
    expect(source).toContain('if (selectable && allowIosUITextView && Platform.OS === \'ios\')');
  });

  it('keeps expanded user markdown hugging the bubble instead of pinning list width', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);
    const markdownBodyStart = source.indexOf('function MarkdownBody');
    const markdownBodyEnd = source.indexOf('function ChatPathChipSpan', markdownBodyStart);
    const markdownBodySource = source.slice(markdownBodyStart, markdownBodyEnd);

    expect(bubbleSource).toContain('pinContentWidth={!isUser}');
    expect(markdownBodySource).toContain('if (!pinContentWidth) return;');
    const codeStart = markdownBodySource.indexOf("if (block.type === 'code')");
    const headingStart = markdownBodySource.indexOf("if (block.type === 'heading')", codeStart);
    const codeSource = markdownBodySource.slice(codeStart, headingStart);
    expect(codeStart).toBeGreaterThan(-1);
    expect(headingStart).toBeGreaterThan(codeStart);
    expect(codeSource).not.toContain('<ScrollView');
    expect(codeSource).toContain('围栏代码在气泡内换行');
  });
});
