// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerSendFocusRestore } from '../useComposerSendFocusRestore';

interface HarnessProps {
  composerMutationLocked: boolean;
  sendDispatchInFlight: boolean;
}

let createdEditors: Editor[] = [];

function createEditor(): Editor {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    element: mount,
    extensions: [Document, Paragraph, Text],
    content: '<p>next message</p>',
    editorProps: { handleScrollToSelection: () => true },
  });
  createdEditors.push(editor);
  return editor;
}

describe('useComposerSendFocusRestore', () => {
  let nextFrameId = 1;
  let frames = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    createdEditors = [];
    frames = new Map();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    for (const editor of createdEditors) editor.destroy();
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const flushAnimationFrames = () => {
    act(() => {
      for (let round = 0; frames.size > 0 && round < 10; round += 1) {
        const pendingFrames = [...frames.values()];
        frames.clear();
        for (const callback of pendingFrames) callback(0);
      }
    });
  };

  const renderRestoreHook = (editor: Editor) =>
    renderHook(
      ({ composerMutationLocked, sendDispatchInFlight }: HarnessProps) => {
        useEffect(() => {
          editor.setEditable(!composerMutationLocked);
        }, [composerMutationLocked, editor]);
        return useComposerSendFocusRestore(editor, composerMutationLocked, sendDispatchInFlight);
      },
      {
        initialProps: { composerMutationLocked: false, sendDispatchInFlight: false },
      },
    );

  const focusComposerSelection = (editor: Editor) => {
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 6 });
      editor.view.focus();
    });
    expect(document.activeElement).toBe(editor.view.dom);
  };

  it('restores the focused composer after the temporary send lock', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => editor.view.dom.blur());
    expect(document.activeElement).toBe(document.body);

    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(6);
  });

  it('keeps the intent captured before the first lock when a later capture observes blurred state', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => editor.view.dom.blur());
    // dispatchSend captures a second time after the lock stole focus; this must
    // not overwrite the intent captured while the composer was still focused.
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('keeps the restore intent until every composer lock is released', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => editor.view.dom.blur());

    // The send lock has settled, but voice input still owns the mutation lock.
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: false });
    flushAnimationFrames();
    expect(document.activeElement).toBe(document.body);

    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('does not steal focus from another interactive control', () => {
    const editor = createEditor();
    const button = document.createElement('button');
    document.body.append(button);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => button.focus());
    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();

    expect(document.activeElement).toBe(button);
  });

  it('preserves a non-collapsed message selection created during the send lock', () => {
    const editor = createEditor();
    const message = document.createElement('p');
    const messageText = document.createTextNode('select this message');
    message.append(messageText);
    document.body.prepend(message);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => {
      editor.view.dom.blur();
      const range = document.createRange();
      range.setStart(messageText, 0);
      range.setEnd(messageText, 6);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();

    expect(document.activeElement).toBe(document.body);
    expect(document.getSelection()?.toString()).toBe('select');
  });

  it('does not interrupt a message selection drag before the range expands', () => {
    const editor = createEditor();
    const message = document.createElement('p');
    const messageText = document.createTextNode('start selecting here');
    message.append(messageText);
    document.body.prepend(message);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({ composerMutationLocked: true, sendDispatchInFlight: true });
    act(() => {
      editor.view.dom.blur();
      const range = document.createRange();
      range.setStart(messageText, 0);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    fireEvent.pointerDown(message);

    hook.rerender({ composerMutationLocked: false, sendDispatchInFlight: false });
    flushAnimationFrames();

    expect(document.activeElement).toBe(document.body);
    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(document.getSelection()?.anchorNode).toBe(messageText);
  });
});
