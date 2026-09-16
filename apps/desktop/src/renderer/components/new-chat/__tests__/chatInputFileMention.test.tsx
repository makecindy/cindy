// @vitest-environment jsdom
import { h, props } from './chatInputTestHarness';
import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import { insertFileMentionIntoComposer } from '@/lib/composerActionsBus';
import { getDraft } from '@/lib/composerDraftStore';

async function readyEditor() {
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor!;
  // jsdom has no text layout. Keep focus real, but omit geometric scrolling.
  editor.setOptions({ editorProps: { ...editor.options.editorProps, handleScrollToSelection: () => true } });
  return editor;
}

const request = {
  targetSessionId: 'file-mention-test',
  type: 'file' as const,
  relPath: 'docs/中文 file.md',
  name: '中文 file.md',
};

const inputProps = { ...props, sessionId: request.targetSessionId, initialModel: 'gpt-6-astra' };

it('inserts at the remembered selection, preserves the draft, focuses, and never sends', async () => {
  const onSend = vi.fn();
  const view = render(<ChatInput {...inputProps} onSend={onSend} />);
  const editor = await readyEditor();
  await act(async () => {
    editor.commands.setContent({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'before after' }] },
      { type: 'paragraph', content: [{ type: 'mentionChip', attrs: { kind: 'file', label: 'old.md', path: 'old.md' } }] },
    ] });
    editor.commands.setTextSelection({ from: 7, to: 13 });
  });
  const existingParagraph = editor.getJSON().content![1];
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  try {
    await act(async () => {
      expect(insertFileMentionIntoComposer(request)).toBe(true);
    });
    const paragraph = editor.getJSON().content![0].content!;
    expect(paragraph.filter((node) => node.type === 'mentionChip')).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ kind: 'file', path: request.relPath, label: request.name }) }),
    ]);
    expect(paragraph[0]).toEqual({ type: 'text', text: 'before ' });
    expect(paragraph.at(-1)).toEqual({ type: 'text', text: ' after' });
    // The selected text remains: insertion does not replace the selected range.
    expect(editor.getText()).toContain('before');
    expect(editor.getText()).toContain('after');
    expect(editor.getJSON().content![1]).toEqual(existingParagraph);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(9);
    await waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    await waitFor(() => expect(getDraft(request.targetSessionId)?.text).toEqual(editor.getJSON()));
    expect(onSend).not.toHaveBeenCalled();
  } finally {
    outside.remove();
    view.unmount();
  }
  expect(insertFileMentionIntoComposer(request)).toBe(false);
});

it.each(['disabled', 'voice'] as const)('rejects insertion while %s locks the composer and works after unlocking', async (lock) => {
  const onSend = vi.fn();
  const view = render(<ChatInput {...inputProps} sessionId={`file-lock-${lock}`} onSend={onSend} />);
  const editor = await readyEditor();
  await act(async () => { editor.commands.setContent('<p>Keep this draft</p>'); });
  const before = editor.getJSON();
  h.listening = lock === 'voice';
  view.rerender(<ChatInput {...inputProps} sessionId={`file-lock-${lock}`} disabled={lock === 'disabled'} onSend={onSend} />);
  await act(async () => {
    expect(insertFileMentionIntoComposer({ ...request, targetSessionId: `file-lock-${lock}` })).toBe(false);
  });
  expect(editor.getJSON()).toEqual(before);
  expect(onSend).not.toHaveBeenCalled();
  h.listening = false;
  view.rerender(<ChatInput {...inputProps} sessionId={`file-lock-${lock}`} onSend={onSend} />);
  await act(async () => {
    expect(insertFileMentionIntoComposer({ ...request, targetSessionId: `file-lock-${lock}` })).toBe(true);
  });
  expect(editor.getJSON().content![0].content!.filter((node) => node.type === 'mentionChip')).toHaveLength(1);
  expect(onSend).not.toHaveBeenCalled();
});
