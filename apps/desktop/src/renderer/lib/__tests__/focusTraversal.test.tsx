// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';

import { handOffTabFromCard } from '../focusTraversal';

/**
 * 模拟底栏形态：触发器、紧随其后的浮层宿主（卡内若干可聚焦元素）、
 * 宿主之后的下一枚 chip —— 与底栏修复后的 DOM 顺序一致。
 */
function CardHarness({ extraInsideMiddle }: { extraInsideMiddle?: boolean }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <button type="button" id="usage-chip">用量明细</button>
      <div ref={setHost} data-testid="card-host">
        {host && (
          <div id="card-root" data-testid="card-root">
            <button type="button" id="card-region">卡内滚动区</button>
            {extraInsideMiddle && <button type="button" id="card-middle">卡内中间</button>}
            <button type="button" id="card-last">卡内最后一档</button>
          </div>
        )}
      </div>
      <button type="button" id="ctx-chip">任务上下文窗口</button>
      <button type="button" id="ring">点击压缩上下文</button>
    </>
  );
}

describe('handOffTabFromCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('Tab 在卡内最后一个可 Tab 边缘时，把焦点交出卡外（下一枚 chip）', () => {
    render(<CardHarness />);
    const cardRoot = document.getElementById('card-root')!;
    const last = document.getElementById('card-last')!;
    const ctxChip = document.getElementById('ctx-chip')!;

    last.focus();
    const handled = handOffTabFromCard(cardRoot, { shiftKey: false });
    expect(handled).toBe(true);
    expect(document.activeElement).toBe(ctxChip);
  });

  it('Shift+Tab 在卡内第一个可 Tab 边缘时，把焦点交出卡外（上一枚 chip / 触发器）', () => {
    render(<CardHarness />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('card-region')!.focus();
    const usage = document.getElementById('usage-chip')!;

    expect(handOffTabFromCard(cardRoot, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(usage);
  });

  it('卡内中间元素的 Tab 不接管（让浏览器的自然顺序继续走）', () => {
    render(<CardHarness extraInsideMiddle />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('card-region')!.focus();
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(false);
    // 自然行为：调用方不 preventDefault，浏览器把焦点走到下一个元素（中间档）。
    expect(document.activeElement).toBe(document.getElementById('card-region'));
    fireEvent.keyDown(document.getElementById('card-region')!, { key: 'Tab' });
    expect(document.activeElement).toBe(document.getElementById('card-region'));
  });

  it('焦点不在卡内时不做任何事', () => {
    render(<CardHarness />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('ctx-chip')!.focus();
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('ctx-chip'));
  });
});
