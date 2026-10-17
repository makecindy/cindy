// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMessageContentLayout, nextSettledContentWidth } from '@/session/messageContentLayout';
import { selectableTextVerticalOffset } from '@/session/selectableTextAlignment';
import { rendererFunction, rendererSource, executeRenderer } from './fixtures/messageRendererComponents';
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

// Regression: PR-watch Markdown used to mount a giant iOS UITextView after
// expansion, causing blank content. Execute the existing collapse hooks/bubble
// and MarkdownBody callbacks; only native surfaces and inline formatting adapt.
function bodyStatement(name: string, functionName: string): ts.Statement {
  const statement = rendererFunction(functionName).body!.statements.find(candidate =>
    ts.isVariableStatement(candidate) && candidate.declarationList.declarations.some(declaration => {
      const names = ts.isIdentifier(declaration.name) ? [declaration.name.text]
        : ts.isArrayBindingPattern(declaration.name) ? declaration.name.elements.flatMap(element => ts.isBindingElement(element) && ts.isIdentifier(element.name) ? [element.name.text] : []) : [];
      return names.includes(name);
    }));
  if (!statement) throw new Error('Renderer state declaration was not found: ' + name);
  return statement;
}
const bubbleStatements = rendererFunction('MessageBubble').body!.statements;
const collapseStart = bubbleStatements.indexOf(bodyStatement('automationOrigin', 'MessageBubble'));
const collapseEnd = bubbleStatements.indexOf(bodyStatement('longMessageCollapsed', 'MessageBubble'));
const collapseCode = bubbleStatements.slice(collapseStart, collapseEnd + 1).map(statement => statement.getText(rendererSource)).join(String.fromCharCode(10));
const markdownStateCode = ['contentWidth', 'handleSettledWidthLayout', 'pinSettledWidth', 'settledTextStyle', 'renderSingleBlock']
  .map(name => bodyStatement(name, 'MarkdownBody').getText(rendererSource)).join(String.fromCharCode(10));
const markdownReturn = rendererFunction('MarkdownBody').body!.statements.find(ts.isReturnStatement);
if (!markdownReturn) throw new Error('MarkdownBody return was not found');

let root: Root;
let host: HTMLDivElement;
const nativeLayouts = new Map<string, (event: unknown) => void>();
const nativeTextLayouts = new Map<string, (event: unknown) => void>();
type SurfaceProps = { children?: React.ReactNode; testID?: string; style?: unknown; onPress?: () => void; onLayout?: (event: unknown) => void; onTextLayout?: (event: unknown) => void; numberOfLines?: number; accessibilityElementsHidden?: boolean };
function NativeView(props: SurfaceProps) {
  if (props.onLayout) nativeLayouts.set(props.testID ?? 'anonymous', props.onLayout);
  return React.createElement('div', { 'data-testid': props.testID, 'data-hidden': props.accessibilityElementsHidden, 'data-style': JSON.stringify(props.style) }, props.children);
}
function nativeText(surface: string) {
  return (props: SurfaceProps) => {
    if (props.onTextLayout) nativeTextLayouts.set(props.testID ?? 'measure', props.onTextLayout);
    return React.createElement(props.onPress ? 'button' : 'span', {
      'data-testid': props.testID, 'data-surface': surface, 'data-max-lines': props.numberOfLines,
      'data-style': JSON.stringify(props.style), onClick: props.onPress,
    }, props.children);
  };
}
const Text = nativeText('rn-text');
const UITextView = nativeText('ios-text-view');
const ScrollView = (props: SurfaceProps) => React.createElement('div', { 'data-scroll': true }, props.children);
const { BubbleHarness, MarkdownHarness } = executeRenderer<{ BubbleHarness: React.ComponentType<any>; MarkdownHarness: React.ComponentType<any> }>(
  rendererFunction('MarkdownSelectableText').getText(rendererSource) + String.raw`
function MarkdownHarness({ pinContentWidth = false, allowIosUITextView = true, selectable, text, layout, code = false }) {
  const styles = {};
  const onOpenPayload = undefined;
  const inlinesSelectable = () => true;
  const spanFor = () => undefined;
  const renderInlines = inlines => inlines.map(inline => inline.text).join('');
  const t = i18n.t.bind(i18n);
  ` + markdownStateCode + String.raw`
  const groups = [{ type: 'block', key: 'body', block: code
    ? { type: 'code', key: 'code', text, language: 'text' }
    : { type: 'paragraph', key: 'paragraph', inlines: [{ type: 'text', text }] } }];
  ` + markdownReturn.getText(rendererSource) + String.raw`
}
const MarkdownBody = MarkdownHarness;
function BubbleHarness({ body, kind = 'user', automationOrigin: origin }) {
  const styles = {};
  const isUser = kind === 'user';
  const item = { message: { kind, body, automationOrigin: origin } };
  const displayBubbleBody = body;
  const bubbleBody = body;
  const hasPluginInvocations = false;
  const userBubbleColors = undefined;
  const actions = {};
  const colors = {};
  const presentation = {};
  const rendersSentInlineBody = false;
  const canSelectVisibleText = true;
  const isStreamingAssistant = false;
  const contentLayout = buildMessageContentLayout({ screenWidth: 402 });
  const t = i18n.t.bind(i18n);
  ` + collapseCode + bodyStatement('bubble', 'MessageBubble').getText(rendererSource) + String.raw`
  return bubble;
}
return { BubbleHarness, MarkdownHarness };
`, {
    useContext: React.useContext, useRef: React.useRef, useMemo: React.useMemo,
    useEffect: React.useEffect, useCallback: React.useCallback, useRecyclingState: React.useState,
    SelectionQuoteContext: React.createContext(null), useWindowDimensions: () => ({ fontScale: 1 }),
    Platform: { OS: 'ios' }, StyleSheet: { flatten: (style: unknown) => style },
    selectableTextVerticalOffset, MAX_FONT_SIZE_MULTIPLIER: 2, i18n,
    View: NativeView, Text, UITextView, ScrollView,
    buildMessageContentLayout, nextSettledContentWidth,
    MarkdownBlockContent: ({ block, renderBlock }: { block: unknown; renderBlock: (block: unknown) => React.ReactNode }) => renderBlock(block),
    HighlightedCodeText: ({ text }: { text: string }) => React.createElement('code', null, text),
    mayExceedVisualLineThreshold, resolveUserMessageCollapse,
    AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD, AUTOMATION_USER_MESSAGE_COLLAPSED_LINES,
    LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD, LONG_USER_MESSAGE_COLLAPSED_LINES,
  });

describe('MessageRenderer bounded long-message native behavior', () => {
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await i18n.changeLanguage('en');
    host = document.createElement('div');
    root = createRoot(host);
    nativeLayouts.clear();
    nativeTextLayouts.clear();
  });
  afterEach(() => act(() => root.unmount()));

  it('bounds hidden native measurement and keeps the message collapsible after its capped layout reply', () => {
    act(() => root.render(React.createElement(BubbleHarness, { body: PR_WATCH_EXPANDED_BLANK_FIXTURE })));
    const measure = host.querySelector('[data-hidden="true"] [data-max-lines]');
    expect(measure?.getAttribute('data-max-lines')).toBe(String(LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1));
    act(() => nativeTextLayouts.get('measure')!({ nativeEvent: { lines: Array.from({ length: Number(measure!.getAttribute('data-max-lines')) }, () => ({ text: 'line' })) } }));
    expect(host.querySelector('[data-testid="message.collapsedBody"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="message.collapseToggle"]')).not.toBeNull();
    // Automation inputs use the actual tighter threshold, including their native cap.
    act(() => root.render(React.createElement(BubbleHarness, { body: PR_WATCH_EXPANDED_BLANK_FIXTURE, automationOrigin: { kind: 'schedule' } })));
    expect(host.querySelector('[data-hidden="true"] [data-max-lines]')?.getAttribute('data-max-lines'))
      .toBe(String(AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1));
  });

  it('uses RN Text for expanded long iOS messages while ordinary selectable messages keep UITextView', () => {
    act(() => root.render(React.createElement(BubbleHarness, { body: 'A short message' })));
    expect(host.querySelector('[data-testid="message.markdownBody"] [data-surface]')?.getAttribute('data-surface')).toBe('ios-text-view');
    act(() => root.render(React.createElement(BubbleHarness, { body: PR_WATCH_EXPANDED_BLANK_FIXTURE })));
    expect(host.querySelector('[data-testid="message.collapsedBody"]')?.getAttribute('data-surface')).toBe('ios-text-view');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="message.collapseToggle"]')!.click());
    expect(host.querySelector('[data-testid="message.markdownBody"] [data-surface]')?.getAttribute('data-surface')).toBe('rn-text');
    expect(host.querySelector('[data-testid="message.markdownBody"]')?.textContent).toBe(PR_WATCH_EXPANDED_BLANK_FIXTURE);
  });

  it('keeps user markdown at its content width and wraps fenced code without a nested scroll host', () => {
    const body = PR_WATCH_EXPANDED_BLANK_FIXTURE;
    act(() => root.render(React.createElement(BubbleHarness, { body })));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="message.collapseToggle"]')!.click());
    const markdown = () => host.querySelector('[data-testid="message.markdownBody"]')!;
    const before = markdown().getAttribute('data-style');
    act(() => nativeLayouts.get('message.markdownBody')!({ nativeEvent: { layout: { width: 402 } } }));
    expect(markdown().getAttribute('data-style')).toBe(before);
    expect(markdown().firstElementChild?.getAttribute('data-style')).toBe('null');
    act(() => root.render(React.createElement(MarkdownHarness, { text: 'agent', selectable: true, pinContentWidth: true, layout: buildMessageContentLayout({ screenWidth: 402 }) })));
    act(() => nativeLayouts.get('message.markdownBody')!({ nativeEvent: { layout: { width: 402 } } }));
    expect(JSON.parse(markdown().firstElementChild!.getAttribute('data-style')!)).toMatchObject({ width: 402 });
    const code = 'code '.repeat(200);
    act(() => root.render(React.createElement(MarkdownHarness, { text: code, code: true, layout: buildMessageContentLayout({ screenWidth: 402 }) })));
    expect(host.querySelector('code')?.textContent).toBe(code);
    expect(host.querySelector('[data-scroll]')).toBeNull();
  });
});
