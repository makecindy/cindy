// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserCommentDesignBaseline } from '../../../../../../shared/browserComment';
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

function ControlledPopover({
  initialDraft = EMPTY_DRAFT,
  designBaseline = null,
  submitting = false,
  onEditorDraftChange = vi.fn(),
  onPreviewDesign = vi.fn(),
}: {
  initialDraft?: BrowserCommentEditorDraft;
  designBaseline?: BrowserCommentDesignBaseline | null;
  submitting?: boolean;
  onEditorDraftChange?: (draft: BrowserCommentEditorDraft) => void;
  onPreviewDesign?: (payload: { styles: Record<string, string>; text: string | null }) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <div>
      <BrowserCommentPopover
        anchor={{ x: 120, y: 80 }}
        submitting={submitting}
        designBaseline={designBaseline}
        editorDraft={draft}
        onEditorDraftChange={(next) => {
          onEditorDraftChange(next);
          setDraft(next);
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onPreviewDesign={onPreviewDesign}
        onResetDesign={vi.fn()}
      />
    </div>
  );
}

describe('BrowserCommentPopover', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('writes comment text into the controlled Host draft', () => {
    const onEditorDraftChange = vi.fn();
    render(<ControlledPopover onEditorDraftChange={onEditorDraftChange} />);

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
      <ControlledPopover
        designBaseline={{
          styles: {},
          editableText: 'Save',
          provenance: {},
        }}
        onEditorDraftChange={onEditorDraftChange}
        onPreviewDesign={onPreviewDesign}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.styleTweaksExpand' }));
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

  it('describes the next style-toggle action and the submitting disabled reason', () => {
    const designBaseline: BrowserCommentDesignBaseline = {
      styles: {},
      editableText: 'Save',
      provenance: {},
    };
    const { rerender } = render(<ControlledPopover designBaseline={designBaseline} />);

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.styleTweaksExpand' }));
    expect(
      screen.getByRole('button', { name: 'rightSidebar.browser.styleTweaksCollapse' }),
    ).toBeTruthy();

    rerender(<ControlledPopover designBaseline={designBaseline} submitting />);
    expect(
      screen
        .getByRole('button', { name: 'rightSidebar.browser.styleTweaksSubmitting' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('replays restored design edits when it binds to a replacement target', async () => {
    const onPreviewDesign = vi.fn();
    render(
      <ControlledPopover
        initialDraft={{
          text: 'Keep the host comment',
          styleEdits: { color: '#ff0000' },
          textEdit: 'Save changes',
        }}
        designBaseline={{
          styles: { color: 'rgb(0, 0, 0)' },
          editableText: 'Save',
          provenance: {},
        }}
        onPreviewDesign={onPreviewDesign}
      />,
    );

    await waitFor(() => {
      expect(onPreviewDesign).toHaveBeenCalledWith({
        styles: { color: '#ff0000' },
        text: 'Save changes',
      });
    });
  });

  it('drops a restored text edit when the replacement target is not safely editable', async () => {
    const onEditorDraftChange = vi.fn();
    const onPreviewDesign = vi.fn();
    render(
      <ControlledPopover
        initialDraft={{
          text: 'Keep the host comment',
          styleEdits: { color: '#ff0000' },
          textEdit: 'Do not replace child DOM',
        }}
        designBaseline={{
          styles: { color: 'rgb(0, 0, 0)' },
          editableText: null,
          provenance: {},
        }}
        onEditorDraftChange={onEditorDraftChange}
        onPreviewDesign={onPreviewDesign}
      />,
    );

    await waitFor(() => {
      expect(onEditorDraftChange).toHaveBeenCalledWith({
        text: 'Keep the host comment',
        styleEdits: { color: '#ff0000' },
        textEdit: null,
      });
    });
    expect(onPreviewDesign).toHaveBeenCalledWith({
      styles: { color: '#ff0000' },
      text: null,
    });
  });
});
