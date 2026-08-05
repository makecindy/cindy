// @vitest-environment jsdom

/**
 * sessionRenameAiFill.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖(AI 改名结果只填入编辑框、不直接生效):
 * - Magic 按钮生成成功 → 标题填入输入框(经 onValueChange),不调用 onCommit,
 *   且 generating 复位(spinner 消失,可再次生成);
 * - 填入后用户 Enter → 才以填入的标题提交;
 * - 填入后用户 Escape → onCancel,标题不生效;
 * - 生成期间编辑被终结(组件卸载)→ 迟到结果被 mountedRef 守卫丢弃。
 * - 侧栏 active 反相底色上,input 与 Magic 按钮统一使用 active foreground。
 */

import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { regenerateSessionTitleFor } from '@/lib/makerTransport';
import { SessionRenameInput } from '../features/cc-agent/SessionRenameInput';

vi.mock('@/lib/makerTransport', () => ({
  regenerateSessionTitleFor: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 受控 value 的最小宿主:模拟调用方的 draft state。 */
function Harness(props: { onCommit: (raw: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('旧标题');
  return createElement(SessionRenameInput, {
    sessionId: 's1',
    value,
    onValueChange: setValue,
    onCommit: props.onCommit,
    onCancel: props.onCancel,
  });
}

async function renderAndGenerate(onCommit: (raw: string) => void, onCancel: () => void) {
  vi.mocked(regenerateSessionTitleFor).mockResolvedValue({ title: ' AI 标题 ' });
  const { container } = render(createElement(Harness, { onCommit, onCancel }));
  const input = container.querySelector('input')!;
  const button = container.querySelector('button')!;
  fireEvent.click(button);
  await waitFor(() => expect(input.value).toBe('AI 标题'));
  return { input, container };
}

describe('SessionRenameInput AI rename fills edit state', () => {
  it('uses the active foreground for both rename controls on an active sidebar row', () => {
    const { container } = render(createElement(SessionRenameInput, {
      sessionId: 's1',
      value: '旧标题',
      onValueChange: () => {},
      onCommit: () => {},
      onCancel: () => {},
      inputClassName: 'text-foreground',
      activeForeground: true,
    }));

    const input = container.querySelector('input')!;
    const button = container.querySelector('button')!;
    expect(input.classList.contains('text-sidebar-item-active-foreground')).toBe(true);
    expect(input.classList.contains('text-foreground')).toBe(false);
    expect(button.classList.contains('text-sidebar-item-active-foreground')).toBe(true);
    expect(button.classList.contains('hover:text-sidebar-item-active-foreground')).toBe(true);
  });

  it('generated title fills the input without committing; Enter commits it', async () => {
    const onCommit = vi.fn();
    const { input, container } = await renderAndGenerate(onCommit, () => {});
    expect(onCommit).not.toHaveBeenCalled();
    // generating 已复位:spinner 消失(回到 Sparkles),用户可继续编辑或再次生成
    expect(container.querySelector('.animate-spin')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('AI 标题');
  });

  it('Escape after fill cancels without committing', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { input } = await renderAndGenerate(onCommit, onCancel);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('double-click inside the input does not bubble to the row double-click', async () => {
    // 侧栏行的 onDoubleClick 是"进入改名"入口:dblclick 冒泡出去会
    // setEditValue(displayTitle) 把 AI 刚填入的草稿打回旧值,且其
    // preventDefault 会吃掉浏览器默认的双击选词(实测回归)。
    const rowDoubleClick = vi.fn();
    vi.mocked(regenerateSessionTitleFor).mockResolvedValue({ title: 'AI 标题' });
    const { container } = render(
      createElement(
        'div',
        { onDoubleClick: rowDoubleClick },
        createElement(Harness, { onCommit: () => {}, onCancel: () => {} }),
      ),
    );
    const input = container.querySelector('input')!;
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => expect(input.value).toBe('AI 标题'));

    fireEvent.doubleClick(input);
    expect(rowDoubleClick).not.toHaveBeenCalled();
    expect(input.value).toBe('AI 标题');
  });

  it('late result arriving after the editor is closed is dropped', async () => {
    let resolveTitle!: (value: { title: string }) => void;
    vi.mocked(regenerateSessionTitleFor).mockReturnValue(
      new Promise((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const onCommit = vi.fn();
    const onValueChange = vi.fn();
    const { container, unmount } = render(createElement(SessionRenameInput, {
      sessionId: 's1',
      value: '旧标题',
      onValueChange,
      onCommit,
      onCancel: () => {},
    }));

    fireEvent.click(container.querySelector('button')!);
    // 生成未返回时用户终结编辑(Escape/提交)→ 调用方关闭编辑态、组件卸载
    unmount();
    resolveTitle({ title: 'AI 标题' });
    // 让 handleAiRename 的 await 续体跑完
    await Promise.resolve();
    await Promise.resolve();

    expect(onValueChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
