// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('卡内中间元素的 Tab 不接管（自然顺序继续走，且不触发全文档扫描）', () => {
    render(<CardHarness extraInsideMiddle />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('card-region')!.focus();
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(false);
    // 调用方不 preventDefault，浏览器按自然 Tab 顺序移动焦点（jsdom 不执行 Tab 默认
    // 行为，无法在单测里模拟自然移动；出卡方向的移动由上面两条边缘用例直接断言）。
    expect(document.activeElement).toBe(document.getElementById('card-region'));
  });

  it('display:none 容器里的按钮不会被当成焦点目标（缓存不吞 Tab）', () => {
    // 回归（Greptile P1）：隐藏判定记忆化曾把「尚未发现外层隐藏」的中间包装层缓存为
    // 可见；同一容器里的第二个按钮命中过期缓存后，隐藏按钮被当成出卡目标 → Tab 被吞。
    render(
      <>
        <button type="button" id="usage-chip">用量明细</button>
        <div data-testid="card-host">
          <div id="card-root">
            <button type="button" id="card-last">卡内最后一档</button>
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <div id="hidden-wrap">
            <button type="button" id="hidden-a">隐藏A</button>
            <button type="button" id="hidden-b">隐藏B</button>
          </div>
        </div>
        <button type="button" id="ctx-chip">任务上下文窗口</button>
      </>,
    );
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('card-last')!.focus();
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(true);
    // 焦点必须越过 display:none 的两个按钮，落到可见的下一枚 chip。
    expect(document.activeElement).toBe(document.getElementById('ctx-chip'));
  });

  it('卡内中间的 Tab 只扫卡片子树，不扫全文档（长聊天记录下的键盘性能）', () => {
    render(<CardHarness extraInsideMiddle />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('card-region')!.focus();
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(false);
    // 全文档扫描的标志是被 walk 到 documentElement；卡中间只应 walk 卡根。
    for (const call of walkerSpy.mock.calls) {
      expect(call[0]).toBe(cardRoot);
    }
    walkerSpy.mockRestore();
  });

  it('焦点不在卡内时不做任何事', () => {
    render(<CardHarness />);
    const cardRoot = document.getElementById('card-root')!;
    document.getElementById('ctx-chip')!.focus();
    expect(handOffTabFromCard(cardRoot, { shiftKey: false })).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('ctx-chip'));
  });
});
