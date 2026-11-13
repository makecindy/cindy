// @vitest-environment jsdom
/**
 * Test value: DESIGN §14.6 makes the square shared `Button` the primitive for
 * new icon-only actions, and the composer toolbar has its own chrome tier
 * (bare at rest, pill on hover — `docs/design-rules/container-transform.md`).
 * Both facts live in the rendered class contract, so the guard checks the real
 * component's classes instead of its source text. Minimal input: one plain-text
 * draft and one successful rewrite. Tier: unit; the auxiliary-model IPC is the
 * only mock.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

import { ComposerEnhancePromptButton } from '../ComposerEnhancePromptButton';
import { Tooltip } from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({
  enhancePrompt: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }));

function stubEditor(text: string): Editor {
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
  return {
    getJSON: () => doc,
    getText: () => text,
    isDestroyed: false,
    on: () => undefined,
    off: () => undefined,
    commands: { setContent: vi.fn(), focus: vi.fn(), selectAll: vi.fn() },
    view: { dom: document.createElement('div') },
  } as unknown as Editor;
}

function renderControl(editor: Editor) {
  return render(
    <Tooltip.Provider>
      <ComposerEnhancePromptButton editor={editor} draftKey="draft-1" />
    </Tooltip.Provider>,
  );
}

describe('ComposerEnhancePromptButton uses the shared Button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enhancePrompt.mockResolvedValue({ text: '改写后的提示词', model: 'aux' });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      composer: { enhancePrompt: mocks.enhancePrompt },
    };
  });

  afterEach(cleanup);

  it('增强动作是方形共享 Button,裸态工具条的漆面由这一档的 token 决定', () => {
    renderControl(stubEditor('给这个页面加一个搜索框'));

    const button = screen.getByRole('button', { name: 'newChat.composerEnhance.enhance' });
    expect(button.classList.contains('cindy-button')).toBe(true);
    // 方形用法：宽等于高（28px 档），无横向内边距。
    expect(button.className).toContain('w-7');
    expect(button.className).toContain('px-0');
    // 静息透明，hover 才浮现胶囊外框（与 +/权限/模型 同档）。
    expect(button.className).toContain('[--button-face-bg:transparent]');
    expect(button.className).toContain('[--button-face-border:transparent]');
    expect(button.className).toContain(
      'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--composer-pill-bg)]',
    );
    expect(button.className).toContain(
      'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-border:var(--border-default)]',
    );
    // focus / disabled / pressed 由共享 Button 提供。
    expect(button.className).toContain('focus-visible:ring-[var(--focus-ring)]');
    expect(button.className).toContain('disabled:opacity-60');
    expect(button.getAttribute('data-press-feedback')).not.toBe('none');
  });

  it('撤销动作同样是共享 Button,可用时不呈现禁用态', async () => {
    renderControl(stubEditor('给这个页面加一个搜索框'));

    fireEvent.click(screen.getByRole('button', { name: 'newChat.composerEnhance.enhance' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'newChat.composerEnhance.undo' })).toBeTruthy();
    });

    const undo = screen.getByRole('button', { name: 'newChat.composerEnhance.undo' });
    expect(undo.classList.contains('cindy-button')).toBe(true);
    expect(undo.className).toContain('w-7');
    // 可用就不能看起来是禁用态（DESIGN §14.6）：共享 Button 的禁用漆面只挂在
    // `disabled:` 变体上，所以按钮本身不能是 disabled。
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    expect(undo.className).not.toContain('opacity-40');
  });
});
