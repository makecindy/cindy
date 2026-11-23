// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolPayloadLightbox } from '@/components/chat/ToolPayloadLightbox';
import { Tooltip } from '@/components/ui/tooltip';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/chat/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));
vi.mock('@/components/chat/MarkdownDiffBlock', () => ({
  MarkdownDiffBlock: ({ raw }: { raw: string }) => <div data-testid="raw-diff-view">{raw}</div>,
}));

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
});

afterEach(() => {
  act(() => vi.runOnlyPendingTimers());
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderEditable(
  options: {
    onSave?: (text: string) => void;
    onClose?: () => void;
  } = {},
) {
  const onSave = options.onSave ?? vi.fn();
  const onClose = options.onClose ?? vi.fn();
  render(
    <Tooltip.Provider>
      <ToolPayloadLightbox
        payload={{ kind: 'text', title: 'Edit Pasted Text', text: 'first\nsecond' }}
        textEdit={{ cancelLabel: 'Cancel Editing', saveLabel: 'Save Text', onSave }}
        onClose={onClose}
      />
    </Tooltip.Provider>,
  );
  return { onSave, onClose };
}

describe('ToolPayloadLightbox editable text mode', () => {
  it('focuses the full text draft and saves it verbatim', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    renderEditable({ onSave });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('first\nsecond');

    fireEvent.change(textarea, { target: { value: ' edited\n<text>  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));
    expect(onSave).toHaveBeenCalledWith(' edited\n<text>  ');
  });

  it('copies the current draft rather than the original payload', () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderEditable();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new draft' } });
    fireEvent.click(screen.getByLabelText('chat.lightbox.copyContent'));

    expect(writeText).toHaveBeenCalledWith('new draft');
  });

  it.each(['cancel', 'escape', 'close', 'backdrop'] as const)(
    '%s closes without saving',
    (closeMethod) => {
      vi.useFakeTimers();
      const onSave = vi.fn();
      const onClose = vi.fn();
      renderEditable({ onSave, onClose });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

      if (closeMethod === 'cancel') {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel Editing' }));
      } else if (closeMethod === 'escape') {
        fireEvent.keyDown(document, { key: 'Escape' });
      } else if (closeMethod === 'close') {
        const closeButtons = screen.getAllByLabelText('chat.lightbox.close');
        fireEvent.click(closeButtons[closeButtons.length - 1]);
      } else {
        const overlay = document.querySelector('[data-tool-payload-lightbox-overlay]');
        const backdrop = overlay?.querySelector(':scope > [data-preview-scrim]');
        expect(backdrop).toBeInstanceOf(HTMLElement);
        fireEvent.click(backdrop as HTMLElement);
      }

      expect(onSave).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(200));
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps ordinary text and JSON payloads read-only', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <Tooltip.Provider>
        <ToolPayloadLightbox
          payload={{ kind: 'text', title: 'Pasted Text', text: 'read only' }}
          onClose={() => undefined}
        />
      </Tooltip.Provider>,
    );
    const textPreview = screen.getByRole('textbox', { name: 'Pasted Text' });
    expect(textPreview).toHaveProperty('readOnly', true);
    expect(textPreview).toHaveProperty('value', 'read only');
    expect(document.activeElement).toBe(textPreview);
    expect(screen.queryByRole('button', { name: 'Save Text' })).toBeNull();

    unmount();
    render(
      <Tooltip.Provider>
        <ToolPayloadLightbox
          payload={{ kind: 'json', title: 'Tool Input', toolInput: { ok: true } }}
          onClose={() => undefined}
        />
      </Tooltip.Provider>,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Text' })).toBeNull();
  });

  it('keeps select-all scoped to the focused read-only text preview', () => {
    vi.useFakeTimers();
    render(
      <Tooltip.Provider>
        <ToolPayloadLightbox
          payload={{ kind: 'text', title: 'Pasted Text', text: 'first\nsecond' }}
          onClose={() => undefined}
        />
      </Tooltip.Provider>,
    );

    const textPreview = screen.getByRole('textbox', { name: 'Pasted Text' }) as HTMLTextAreaElement;
    fireEvent.keyDown(document, { key: 'a', metaKey: true });

    expect(textPreview.selectionStart).toBe(0);
    expect(textPreview.selectionEnd).toBe(textPreview.value.length);
  });

  // 测试价值
  // - 生产入口与可观察结果：ToolPayloadLightbox 挂载后由 PreviewHeader 登记为激活的
  //   前景层并抬到 modal 层级；旧图片预览不再盖住新查看器。
  // - Bug／规则依据：#11952 round 10 review PRRT_kwDOTgdRUs66pjK-；
  //   docs/dev-rules/engineering-conventions.md §3.2。
  // - 现有覆盖缺口：既有工具载荷用例只测文本与复制，既有前景层用例未覆盖这个根节点。
  // - 最小失败输入：仅挂载 ToolPayloadLightbox；修复前根节点没有 data-lightbox-layer。
  // - tier：unit；复用现有 jsdom 文件，定向套件实测约 0.34s。
  it('registers the viewer as the active foreground layer', () => {
    vi.useFakeTimers();
    renderEditable();

    const overlay = document.querySelector<HTMLElement>(
      '[data-tool-payload-lightbox-overlay]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.hasAttribute('data-lightbox-layer')).toBe(true);
    expect(overlay?.hasAttribute('data-preview-active')).toBe(true);
    expect(Number(overlay?.style.zIndex)).toBe(Z_INDEX_LAYERS['modal']);
  });
});

describe('ToolPayloadLightbox shared file diff mode', () => {
  it('renders Claude old/new and Codex unified diffs in one multi-file view', () => {
    vi.useFakeTimers();
    render(
      <Tooltip.Provider>
        <ToolPayloadLightbox
          payload={{
            kind: 'diff',
            files: [
              {
                key: 'claude',
                filePath: '/repo/src/claude.ts',
                diffs: [{ key: 'edit:0', oldString: 'old', newString: 'new' }],
              },
              {
                key: 'codex',
                filePath: '/repo/src/codex.ts',
                diffs: [{ key: 'file-change:0', rawDiff: '-before\n+after' }],
              },
            ],
          }}
          onClose={() => undefined}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByText('claude.ts')).toBeTruthy();
    expect(screen.getByText('codex.ts')).toBeTruthy();
    expect(screen.getByTestId('diff-view')).toBeTruthy();
    expect(screen.getByTestId('raw-diff-view').textContent).toBe('-before\n+after');
    expect(screen.queryByLabelText('chat.lightbox.openInExplorer')).toBeNull();
  });

  it('copies every file path and both diff formats without exposing raw tool JSON', () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <Tooltip.Provider>
        <ToolPayloadLightbox
          payload={{
            kind: 'diff',
            files: [
              {
                key: 'claude',
                filePath: '/repo/a.ts',
                diffs: [{ key: 'edit:0', oldString: 'old', newString: 'new' }],
              },
              {
                key: 'codex',
                filePath: '/repo/b.ts',
                diffs: [{ key: 'file-change:0', rawDiff: '-before\n+after' }],
              },
            ],
          }}
          onClose={() => undefined}
        />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByLabelText('chat.lightbox.copyContent'));
    expect(writeText).toHaveBeenCalledWith(
      '--- /repo/a.ts ---\n--- old\nold\n+++ new\nnew\n\n--- /repo/b.ts ---\n-before\n+after',
    );
  });
});
