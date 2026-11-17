// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaintextEditor } from '@/components/markdown/PlaintextEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--app-editor-font-size');
  document.body.style.removeProperty('--app-editor-font-size');
  vi.unstubAllGlobals();
});

describe('PlaintextEditor font-size shortcuts', () => {
  it('leaves code lines unwrapped by default', () => {
    const { container } = render(
      createElement(PlaintextEditor, {
        initialValue: 'const value = 1;',
        language: 'typescript',
      }),
    );
    const editor = container.querySelector<HTMLElement>('.cm-editor')!;
    const view = EditorView.findFromDOM(editor)!;

    expect(view.lineWrapping).toBe(false);
    // 编辑器字号走自己的覆盖变量,缺省回落到代码字号。
    expect(document.head.textContent).toContain('var(--app-editor-font-size');
  });

  it('changes only the editor override and persists the new size', async () => {
    const setPatch = vi.fn(async () => ({}));
    vi.stubGlobal('electronAPI', {
      appearanceSettings: { setPatch },
      logToMain: vi.fn(),
    });
    const { container } = render(
      createElement(PlaintextEditor, {
        initialValue: 'const value = 1;',
        language: 'typescript',
      }),
    );
    const editor = container.querySelector<HTMLElement>('.cm-editor')!;
    const view = EditorView.findFromDOM(editor)!;

    fireEvent.keyDown(view.contentDOM, { key: '=', code: 'Equal', ctrlKey: true });

    expect(document.documentElement.style.getPropertyValue('--app-editor-font-size')).toBe('15px');
    expect(document.body.style.getPropertyValue('--app-editor-font-size')).toBe('15px');
    await waitFor(() => expect(setPatch).toHaveBeenCalledWith({ editorFontSize: 15 }));
  });

  it('shrinks with the primary minus key', async () => {
    const setPatch = vi.fn(async () => ({}));
    vi.stubGlobal('electronAPI', {
      appearanceSettings: { setPatch },
      logToMain: vi.fn(),
    });
    const { container } = render(
      createElement(PlaintextEditor, {
        initialValue: 'const value = 1;',
        language: 'typescript',
      }),
    );
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;

    fireEvent.keyDown(view.contentDOM, { key: '-', code: 'Minus', ctrlKey: true });

    expect(document.documentElement.style.getPropertyValue('--app-editor-font-size')).toBe('13px');
    await waitFor(() => expect(setPatch).toHaveBeenCalledWith({ editorFontSize: 13 }));
  });

  it('continues shrinking across rapid repeated presses', async () => {
    const setPatch = vi.fn(async () => ({}));
    vi.stubGlobal('electronAPI', {
      appearanceSettings: { setPatch },
      logToMain: vi.fn(),
    });
    const { container } = render(
      createElement(PlaintextEditor, {
        initialValue: 'const value = 1;',
        language: 'typescript',
      }),
    );
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;

    fireEvent.keyDown(view.contentDOM, { key: '-', code: 'Minus', ctrlKey: true });
    fireEvent.keyDown(view.contentDOM, { key: '-', code: 'Minus', ctrlKey: true });
    expect(document.documentElement.style.getPropertyValue('--app-editor-font-size')).toBe('12px');
    await waitFor(() => expect(setPatch).toHaveBeenLastCalledWith({ editorFontSize: 12 }));
  });
});
