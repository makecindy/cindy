/**
 * 回归:分享选择模式在长 assistant 正文末尾动态挂载选择框时,消息 item 不能继续
 * 使用 content-visibility 的 intrinsic 占位。否则绝对定位的 20px 选择框会按缓存
 * 盒裁切成近乎不可见的高度。jsdom 不计算这组布局,所以这里锁住 DOM/CSS 契约。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const readRendererSource = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

const messageStreamSource = readRendererSource('components/chat/MessageStream.tsx');
const globalsSource = readRendererSource('styles/globals.css');
const globalsCss = parse(globalsSource);

function cssRuleBody(selector: string): string {
  let body = '';
  globalsCss.walkRules((rule) => {
    if (rule.selectors.includes(selector)) body += rule.toString();
  });
  return body;
}

describe('分享选择模式的消息布局隔离', () => {
  it('只在分享选择激活时给消息流容器挂状态属性', () => {
    expect(messageStreamSource).toContain(
      "data-share-selection-active={shareSelectionActive ? '' : undefined}",
    );
  });

  it('常态消息仍保留 content-visibility 性能优化', () => {
    const rule = cssRuleBody('.msg-stream-items > *');

    expect(rule).toContain('content-visibility: auto;');
    expect(rule).toContain('contain-intrinsic-size: auto 240px;');
  });

  it.each([
    '.msg-stream-items[data-share-selection-active] > [data-share-message-id]',
    '.msg-stream-items[data-share-selection-active] > :has([data-share-message-id])',
  ])('分享模式下可分享消息使用真实布局盒：%s', (selector) => {
    const rule = cssRuleBody(selector);

    expect(rule).toContain('content-visibility: visible;');
    expect(rule).toContain('contain-intrinsic-size: none;');
  });
});
