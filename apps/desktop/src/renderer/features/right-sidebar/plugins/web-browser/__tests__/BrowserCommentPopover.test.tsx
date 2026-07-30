// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserCommentEditorDraft } from '../browserCommentEditorDraft';
import { BrowserCommentPopover } from '../BrowserCommentPopover';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const EMPTY_DRAFT: BrowserCommentEditorDraft = {
  text: '',
  styleEdits: {},
  textEdit: null,
};

describe('BrowserCommentPopover', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('writes comment text into the controlled Host draft', () => {
    const onEditorDraftChange = vi.fn();
    render(
      <div>
        <BrowserCommentPopover
          anchor={{ x: 120, y: 80 }}
          submitting={false}
          designBaseline={null}
          editorDraft={EMPTY_DRAFT}
          onEditorDraftChange={onEditorDraftChange}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onPreviewDesign={vi.fn()}
          onResetDesign={vi.fn()}
        />
      </div>,
    );

    fireEvent.change(screen.getByPlaceholderText('rightSidebar.browser.commentPlaceholder'), {
      target: { value: 'Preserve this comment across WebView replacement' },
    });

    expect(onEditorDraftChange).toHaveBeenCalledWith({
      text: 'Preserve this comment across WebView replacement',
      styleEdits: {},
      textEdit: null,
    });
  });

  it('writes style text edits into the same controlled draft', () => {
    const onEditorDraftChange = vi.fn();
    const onPreviewDesign = vi.fn();
    render(
      <div>
        <BrowserCommentPopover
          anchor={{ x: 120, y: 80 }}
          submitting={false}
          designBaseline={{
            styles: {},
            editableText: 'Save',
            provenance: {},
          }}
          editorDraft={EMPTY_DRAFT}
          onEditorDraftChange={onEditorDraftChange}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          onPreviewDesign={onPreviewDesign}
          onResetDesign={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.styleTweaks' }));
    fireEvent.change(screen.getByDisplayValue('Save'), {
      target: { value: 'Save changes' },
    });

    expect(onEditorDraftChange).toHaveBeenCalledWith({
      text: '',
      styleEdits: {},
      textEdit: 'Save changes',
    });
    expect(onPreviewDesign).toHaveBeenCalledWith({
      styles: {},
      text: 'Save changes',
    });
  });
});
