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

const toastWarning = vi.hoisted(() => vi.fn());

vi.mock('@/lib/makerTransport', () => ({
  regenerateSessionTitleFor: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({
  toast: { warning: toastWarning },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  it('uses a neutral pill editor and reserves blue focus for keyboard navigation', () => {
    const onCommit = vi.fn();
    const { container } = render(
      createElement(SessionRenameInput, {
        sessionId: 's1',
        value: '旧标题',
        onValueChange: () => {},
        onCommit,
        onCancel: () => {},
      }),
    );

    const input = container.querySelector('input')!;
    const button = container.querySelector('button')!;
    expect(input.classList.contains('rounded-full')).toBe(true);
    expect(input.classList.contains('border')).toBe(true);
    expect(input.classList.contains('border-[var(--border-default)]')).toBe(true);
    expect(input.classList.contains('border-[1.5px]')).toBe(false);
    expect(input.classList.contains('border-[var(--focus-ring)]')).toBe(false);
    expect(input.classList.contains('ring-2')).toBe(false);

    // Tab 到 Magic 后 Shift+Tab 回到 input：这是键盘聚焦，应出现蓝色软环。
    fireEvent.blur(input, { relatedTarget: button });
    fireEvent.focus(button);
    fireEvent.blur(button, { relatedTarget: input });
    fireEvent.focus(input);
    expect(input.classList.contains('ring-2')).toBe(true);
    expect(input.classList.contains('ring-[var(--focus-ring-soft)]')).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();

    // 鼠标在输入框或 Magic 上继续操作时隐去蓝环，保留中性描边。
    fireEvent.pointerDown(button);
    expect(input.classList.contains('ring-2')).toBe(false);

    // Magic 保留原有的小圆角几何，只补键盘 focus-visible 反馈。
    expect(button.classList.contains('rounded')).toBe(true);
    expect(button.classList.contains('rounded-full')).toBe(false);
    expect(button.classList.contains('focus-visible:ring-2')).toBe(true);
    expect(button.classList.contains('focus-visible:ring-[var(--focus-ring-soft)]')).toBe(true);
  });

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
    expect(input.classList.contains('border-[var(--border-default)]')).toBe(false);
    expect(
      input.classList.contains(
        'border-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_28%,transparent)]',
      ),
    ).toBe(true);
    expect(button.classList.contains('text-sidebar-item-active-foreground')).toBe(true);
    expect(button.classList.contains('hover:text-sidebar-item-active-foreground')).toBe(true);
  });

  it('clears a stale pointer-focus marker when the input blurs before pointerup', () => {
    const onCommit = vi.fn();
    const { container } = render(
      createElement(SessionRenameInput, {
        sessionId: 's1',
        value: '旧标题',
        onValueChange: () => {},
        onCommit,
        onCancel: () => {},
      }),
    );

    const input = container.querySelector('input')!;
    const button = container.querySelector('button')!;

    // 指针在 input 按下后拖出，pointerup 不再落回 input；Tab 到 Magic 时的 blur
    // 必须清掉该标记，Shift+Tab 回来仍应识别为键盘聚焦并显示蓝环。
    fireEvent.pointerDown(input);
    fireEvent.blur(input, { relatedTarget: button });
    fireEvent.focus(button);
    fireEvent.pointerUp(button);
    fireEvent.blur(button, { relatedTarget: input });
    fireEvent.focus(input);

    expect(input.classList.contains('ring-2')).toBe(true);
    expect(input.classList.contains('ring-[var(--focus-ring-soft)]')).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
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

  it.each([
    ['TITLE_NO_MATERIAL', 'aiRename:noMaterial'],
    ['TITLE_PROVIDER_UNSUPPORTED', 'aiRename:providerUnsupported'],
  ])('maps %s to the matching user action', async (code, expectedKey) => {
    vi.mocked(regenerateSessionTitleFor).mockRejectedValue(
      new Error(`[${code}] safe main-process message`),
    );
    const { container } = render(
      createElement(Harness, { onCommit: () => {}, onCancel: () => {} }),
    );

    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expectedKey));
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('input')?.value).toBe('旧标题');
  });

  it('keeps the generic fallback for an old host returning null or an unknown error', async () => {
    vi.mocked(regenerateSessionTitleFor).mockResolvedValueOnce({ title: null });
    const first = render(createElement(Harness, { onCommit: () => {}, onCancel: () => {} }));
    fireEvent.click(first.container.querySelector('button')!);
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith('ccAgent.rename.aiRenameFailed'),
    );
    first.unmount();

    toastWarning.mockClear();
    vi.mocked(regenerateSessionTitleFor).mockRejectedValueOnce(new Error('[UNKNOWN] failed'));
    const second = render(createElement(Harness, { onCommit: () => {}, onCancel: () => {} }));
    fireEvent.click(second.container.querySelector('button')!);
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith('ccAgent.rename.aiRenameFailed'),
    );
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
