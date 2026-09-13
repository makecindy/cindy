import { describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorProps, EditorView } from '@tiptap/pm/view';

import { handleWindowsSelectedTextInput } from '../components/new-chat/WindowsSelectionReplacement';
import { handlePairedSelectionInput } from '../components/new-chat/SelectionPairing';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' },
  },
});

/** Minimal mutable EditorView facade for exercising DOM-event transactions. */
function makeView(
  state: EditorState,
  composing = false,
  handleTextInput?: NonNullable<EditorProps['handleTextInput']>,
) {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    composing,
    dispatch(transaction: Transaction) {
      current = current.apply(transaction);
    },
    someProp(
      propName: string,
      resolve?: (handler: NonNullable<EditorProps['handleTextInput']>) => unknown,
    ) {
      if (propName === 'handleTextInput' && handleTextInput && resolve) {
        return resolve(handleTextInput);
      }
      return undefined;
    },
  } as unknown as EditorView;
  return { view, getState: () => current };
}

function selectedPrefixState(trailingKind: 'hardBreak' | 'emptyParagraph'): EditorState {
  const text = schema.text('GPT5.5啊啊啊啊');
  const firstParagraph = schema.nodes.paragraph.create(
    null,
    trailingKind === 'hardBreak' ? [text, schema.nodes.hardBreak.create()] : [text],
  );
  const paragraphs =
    trailingKind === 'emptyParagraph'
      ? [firstParagraph, schema.nodes.paragraph.create()]
      : [firstParagraph];
  const doc = schema.nodes.doc.create(null, paragraphs);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, 1, 7)));
}

function documentText(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
}

function inputEvent(data: string, inputType = 'insertText') {
  return {
    cancelable: true,
    data,
    inputType,
    isComposing: false,
    preventDefault: vi.fn(),
  } as unknown as InputEvent;
}

describe('Windows chat composer selection replacement', () => {
  it('lets the shared text-input rule wrap a selected range', () => {
    const initial = selectedPrefixState('hardBreak');
    const { view, getState } = makeView(initial, false, handlePairedSelectionInput);
    const event = inputEvent('(');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

    expect(documentText(getState())).toBe('(GPT5.5)啊啊啊啊\n');
    expect(getState().selection.from).toBe(2);
    expect(getState().selection.to).toBe(8);
  });

  it.each(['hardBreak', 'emptyParagraph'] as const)(
    'replaces a selected prefix before a trailing %s and leaves the caret after the new text',
    (trailingKind) => {
      const { view, getState } = makeView(selectedPrefixState(trailingKind));
      const event = inputEvent('K');

      expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

      const state = getState();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(documentText(state)).toBe('K啊啊啊啊\n');
      expect(state.selection.empty).toBe(true);
      expect(state.selection.from).toBe(2);
    },
  );

  it('also replaces a selected prefix for automatic correction input', () => {
    const { view, getState } = makeView(selectedPrefixState('hardBreak'));
    const event = inputEvent('K', 'insertReplacementText');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(documentText(getState())).toBe('K啊啊啊啊\n');
    expect(getState().selection.from).toBe(2);
  });

  it('also replaces text at a collapsed caret through ProseMirror', () => {
    const selected = selectedPrefixState('hardBreak');
    const collapsed = selected.apply(
      selected.tr.setSelection(TextSelection.create(selected.doc, 1)),
    );
    const { view, getState } = makeView(collapsed);
    const event = inputEvent('你');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(documentText(getState())).toBe('你GPT5.5啊啊啊啊\n');
    expect(getState().selection.from).toBe(2);
  });

  it('preserves ProseMirror text-input handlers', () => {
    const initial = selectedPrefixState('hardBreak');
    const handleTextInput = vi.fn(() => true);
    const { view, getState } = makeView(initial, false, handleTextInput);
    const event = inputEvent('K');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

    expect(handleTextInput).toHaveBeenCalledOnce();
    expect(handleTextInput).toHaveBeenCalledWith(view, 1, 7, 'K', expect.any(Function));
    expect(getState()).toBe(initial);
  });

  it('leaves native input alone when there is no inserted text', () => {
    const selected = selectedPrefixState('hardBreak');
    const collapsed = selected.apply(
      selected.tr.setSelection(TextSelection.create(selected.doc, 1)),
    );
    const { view, getState } = makeView(collapsed);
    const event = inputEvent('');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getState()).toBe(collapsed);
  });

  it('leaves collapsed automatic replacement ranges to Chromium', () => {
    const selected = selectedPrefixState('hardBreak');
    const collapsed = selected.apply(
      selected.tr.setSelection(TextSelection.create(selected.doc, 1)),
    );
    const { view, getState } = makeView(collapsed);
    const event = inputEvent('K', 'insertReplacementText');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getState()).toBe(collapsed);
  });

  it('does not intercept composition text in beforeinput', () => {
    const { view } = makeView(selectedPrefixState('hardBreak'), true);
    const event = inputEvent('n');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
