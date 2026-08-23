import { useCallback, useEffect, useRef } from 'react';

import { isInteractiveFocusedElement } from './composerBlankPointerFocus';

export interface ComposerFocusEditor {
  readonly isDestroyed: boolean;
  readonly isEditable: boolean;
  readonly isFocused: boolean;
  readonly view: { readonly dom: HTMLElement };
  readonly commands: { focus: () => unknown };
}

interface PendingComposerFocusRestore {
  readonly editor: ComposerFocusEditor;
  readonly focusAnchor: Element | null;
}

export function hasFocusMovedToInteractiveElement(
  focusAnchor: Element | null,
  editorDom: HTMLElement,
): boolean {
  const activeElement = editorDom.ownerDocument.activeElement;
  if (
    !activeElement ||
    activeElement === editorDom.ownerDocument.body ||
    activeElement === editorDom.ownerDocument.documentElement
  ) {
    return false;
  }
  if (activeElement === focusAnchor) return false;
  if (editorDom.contains(activeElement)) return false;
  return isInteractiveFocusedElement(activeElement);
}

export function hasNonCollapsedSelectionOutsideComposer(editorDom: HTMLElement): boolean {
  const selection = editorDom.ownerDocument.getSelection?.() ?? null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return false;
  return !editorDom.contains(anchorNode) || !editorDom.contains(focusNode);
}

export function useComposerSendFocusRestore(
  editor: ComposerFocusEditor | null,
  composerMutationLocked: boolean,
  sendDispatchInFlight: boolean,
): () => void {
  const pendingRestoreRef = useRef<PendingComposerFocusRestore | null>(null);

  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    const ownerDocument = editorDom.ownerDocument;
    const cancelRestoreForOutsidePointer = (event: PointerEvent) => {
      const pendingRestore = pendingRestoreRef.current;
      if (!pendingRestore || pendingRestore.editor !== editor) return;
      const target = event.target;
      if (target instanceof Node && editorDom.contains(target)) return;
      pendingRestoreRef.current = null;
    };

    ownerDocument.addEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || sendDispatchInFlight || composerMutationLocked) return;

    const pendingRestore = pendingRestoreRef.current;
    if (!pendingRestore) return;
    if (pendingRestore.editor !== editor) {
      pendingRestoreRef.current = null;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (pendingRestoreRef.current !== pendingRestore) return;
      if (editor.isDestroyed) {
        pendingRestoreRef.current = null;
        return;
      }
      // A second lock can begin before this frame runs. Keep the pending intent
      // so the next unlocked effect can try again instead of dropping it.
      if (!editor.isEditable) return;
      if (editor.isFocused) {
        pendingRestoreRef.current = null;
        return;
      }
      if (
        hasFocusMovedToInteractiveElement(pendingRestore.focusAnchor, editor.view.dom) ||
        hasNonCollapsedSelectionOutsideComposer(editor.view.dom)
      ) {
        pendingRestoreRef.current = null;
        return;
      }

      pendingRestoreRef.current = null;
      editor.commands.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [composerMutationLocked, editor, sendDispatchInFlight]);

  return useCallback(() => {
    // dispatchSend 会在本地路径与远端路径各捕获一次焦点（第二处在 effort settle 后触发）。
    // 旧实现 restoreFocusAfterDispatchRef 用 || 合并防止互相覆盖；此捕获函数是直接赋值，
    // 本地路径第一处捕获后 setEditable(false) 已打掉焦点，第二处捕获时 editor.isFocused 为 false，
    // 会把第一处记住的 intent 覆盖成 null，解锁后不再恢复光标。
    // 因此同一 editor 已有待恢复 intent 时，后续捕获直接跳过。
    if (pendingRestoreRef.current && pendingRestoreRef.current.editor === editor) {
      return;
    }
    pendingRestoreRef.current =
      editor && !editor.isDestroyed && editor.isFocused
        ? { editor, focusAnchor: editor.view.dom.ownerDocument.activeElement }
        : null;
  }, [editor]);
}
