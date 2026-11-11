// @vitest-environment jsdom
import { Editor, Mark } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import { undoDepth, redoDepth } from '@tiptap/pm/history';
import { AllSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreComposerDocument } from '../components/new-chat/restoreComposerDocument';

const TestMark = Mark.create({ name: 'testMark', renderHTML: () => ['strong', 0] });
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });
function create(content = '<p></p>') {
  const editor = new Editor({ extensions: [Document, Paragraph, Text, History, TestMark], content, parseOptions: { preserveWhitespace: 'full' } });
  editors.push(editor);
  return editor;
}
describe('empty composer task switch', () => {
  it.each([undefined, { type: 'doc', content: [{ type: 'paragraph' }] }])('skips untouched empty replacement %j', (draft) => {
    const editor = create();
    const transaction = vi.fn(); editor.on('transaction', transaction);
    for (let i = 0; i < 6; i++) restoreComposerDocument(editor, draft);
    expect(transaction).not.toHaveBeenCalled();
    expect(undoDepth(editor.state)).toBe(0);
  });
  it.each(['<p>text</p>', '<p> </p>', '<p></p><p></p>'])('resets noncanonical content %s', (content) => {
    const editor = create(content);
    const transaction = vi.fn(); editor.on('transaction', transaction);
    restoreComposerDocument(editor);
    expect(transaction).toHaveBeenCalled();
    expect(editor.state.doc.eq(editor.schema.topNodeType.createAndFill()!)).toBe(true);
  });
  it.each(['undo', 'redo'] as const)('retains the reset when %s history exists', (kind) => {
    const editor = create();
    editor.commands.insertContent('text');
    if (kind === 'redo') editor.commands.undo();
    else editor.commands.clearContent();
    expect((kind === 'undo' ? undoDepth : redoDepth)(editor.state)).toBeGreaterThan(0);
    expect(editor.state.doc.textContent).toBe('');
    const transaction = vi.fn(); editor.on('transaction', transaction);
    restoreComposerDocument(editor);
    expect(transaction).toHaveBeenCalled();
  });
  it.each(['selection', 'marks', 'composing'])('retains the reset for %s state', (kind) => {
    const editor = create();
    if (kind === 'selection') editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    if (kind === 'marks') editor.view.dispatch(editor.state.tr.addStoredMark(editor.schema.marks.testMark.create()));
    if (kind === 'composing') vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true);
    const transaction = vi.fn(); editor.on('transaction', transaction);
    restoreComposerDocument(editor);
    expect(transaction).toHaveBeenCalled();
  });
  it('restores nonempty and noncanonical target drafts', () => {
    for (const content of [
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'draft' }] }] },
      { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] },
    ]) {
      const editor = create();
      restoreComposerDocument(editor, content);
      expect(editor.state.doc.eq(editor.schema.nodeFromJSON(content))).toBe(true);
    }
  });
  it('retains the reset for voice and other explicit transition state', () => {
    const editor = create();
    const transaction = vi.fn(); editor.on('transaction', transaction);
    restoreComposerDocument(editor, undefined, true);
    expect(transaction).toHaveBeenCalled();
  });
});
