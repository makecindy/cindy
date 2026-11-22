import { useLayoutEffect, useRef, useState, type RefObject, type KeyboardEvent } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useTranslation } from 'react-i18next';
import {
  PastedTextChipNode,
  applyPastedTextChipEdit,
  replacePastedTextChipWithPlainText,
} from '@/components/new-chat/PastedTextChipNode';
import {
  countPasteLines,
  isLongPasteText,
  LONG_PASTE_MAX_CHARS,
} from '@/components/new-chat/longPasteText';
import { ToolPayloadLightbox } from '@/components/chat/ToolPayloadLightbox';
import { botGroupDraftDoc } from './botGroupAttachments';
import { BOT_GROUP_COMPOSER_INPUT } from './botGroupComposerChrome';
import type { BotGroupInitialPaste, BotGroupTextInput } from './botGroupTextInput';

function textOf(node: PMNode): string {
  if (node.isText) return node.text ?? '';
  if (node.type.name === 'pastedTextChip') return node.attrs.text;
  if (node.type.name === 'hardBreak') return '\n';
  const parts: string[] = [];
  node.forEach((child) => parts.push(textOf(child)));
  return parts.join(node.type.name === 'doc' ? '\n' : '');
}

function textOffset(doc: PMNode, pos: number): number {
  return textOf(doc.cut(0, pos)).length;
}

type TextPosition = {
  pos: number;
  insideChip?: { text: string; offset: number; size: number };
};

function locateTextPosition(doc: PMNode, offset: number): TextPosition {
  let result: TextPosition | undefined;
  let start = 0;
  doc.forEach((paragraph, paragraphPos) => {
    if (result) return;
    // Even an empty paragraph has a valid caret before its closing boundary.
    if (offset <= start) {
      result = { pos: paragraphPos + 1 };
      return;
    }
    paragraph.forEach((node, nodePos) => {
      if (result) return;
      const pos = paragraphPos + 1 + nodePos;
      const text = textOf(node);
      const localOffset = offset - start;
      if (localOffset <= text.length) {
        if (node.isText) result = { pos: pos + localOffset };
        else if (node.type.name === 'pastedTextChip' && localOffset > 0 && localOffset < text.length)
          result = { pos, insideChip: { text, offset: localOffset, size: node.nodeSize } };
        else result = { pos: localOffset === 0 ? pos : pos + node.nodeSize };
      }
      start += text.length;
    });
    start++; // textOf inserts one newline between paragraphs.
  });
  return result ?? { pos: Math.max(1, doc.content.size - 1) };
}

function positionAt(doc: PMNode, offset: number): number {
  const { pos, insideChip } = locateTextPosition(doc, offset);
  return pos + (insideChip?.size ?? 0);
}

export function BotGroupTextEditor({
  value,
  initialPaste,
  inputRef,
  disabled,
  readOnly,
  foldRestoredValue,
  label,
  placeholder,
  maxLength = -1,
  onChange,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  onSelect,
  ariaProps,
}: {
  value: string;
  initialPaste?: BotGroupInitialPaste | null;
  inputRef: RefObject<BotGroupTextInput | null>;
  disabled: boolean;
  readOnly: boolean;
  foldRestoredValue: boolean;
  label: string;
  placeholder: string;
  maxLength?: number;
  onChange: (text: string, edit: { start: number; end: number; caret: number }) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onSelect: () => void;
  ariaProps: Record<string, string | undefined>;
}) {
  const { t } = useTranslation();
  const editable = !disabled && !readOnly;
  const latest = useRef({ onChange, onSelect, maxLength, editable, placeholder });
  latest.current = { onChange, onSelect, maxLength, editable, placeholder };
  const [edit, setEdit] = useState<{ pos: number; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  const labelFor = (text: string) =>
    t('newChat.pastedText.chipLabel', { lines: countPasteLines(text) });
  const chipNode = (text: string): JSONContent => ({
    type: 'pastedTextChip', attrs: { text, display: labelFor(text) },
  });
  const chipDoc = (text: string): JSONContent => ({
    type: 'doc', content: [{ type: 'paragraph', content: [chipNode(text)] }],
  });
  const plainNodes = (text: string): JSONContent[] =>
    text
      .split('\n')
      .flatMap((line, i) => [
        ...(i ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]);
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    onCreate: ({ editor: created }) => {
      if (initialPaste) {
        const start = positionAt(created.state.doc, initialPaste.before.length);
        const end = positionAt(
          created.state.doc,
          initialPaste.before.length + initialPaste.selected.length,
        );
        const tr = created.state.tr
          .replaceWith(
            start,
            end,
            created.schema.nodes.pastedTextChip.create({
              text: initialPaste.text,
              display: labelFor(initialPaste.text),
            }),
          )
          .setMeta('preventUpdate', true);
        created.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
        created.view.dom.focus();
      }
      setReady(true);
    },
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      PastedTextChipNode,
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
    ],
    content: initialPaste
      ? botGroupDraftDoc(initialPaste.before + initialPaste.selected + initialPaste.after)
      : foldRestoredValue
        ? chipDoc(value)
        : botGroupDraftDoc(value),
    editorProps: {
      clipboardTextSerializer: (slice) => {
        const parts: string[] = [];
        slice.content.forEach((node) => parts.push(textOf(node)));
        return parts.join('\n');
      },
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-disabled': String(disabled),
        'aria-readonly': String(readOnly),
        // Tiptap removes its default tab stop in read-only mode, but the
        // keyboard still needs to reach the composer to stop dictation.
        ...(disabled ? {} : { tabindex: '0' }),
        class: `${BOT_GROUP_COMPOSER_INPUT} whitespace-pre-wrap`,
      },
      handleClickOn: (_view, _pos, node, nodePos) => {
        if (node.type.name !== 'pastedTextChip' || !latest.current.editable) return false;
        setEdit({ pos: nodePos, text: node.attrs.text });
        return true;
      },
      handlePaste: (view, event) => {
        if (!latest.current.editable) {
          event.preventDefault();
          return true;
        }
        const text = event.clipboardData?.getData('text/plain');
        if (!text || event.defaultPrevented) return false;
        event.preventDefault();
        if (
          latest.current.maxLength >= 0 &&
          textOf(view.state.doc).length -
            (textOffset(view.state.doc, view.state.selection.to) -
              textOffset(view.state.doc, view.state.selection.from)) +
            text.length >
            latest.current.maxLength
        )
          return true;
        if (isLongPasteText(text))
          view.dispatch(
            view.state.tr.replaceSelectionWith(
              view.state.schema.nodes.pastedTextChip.create({ text, display: labelFor(text) }),
            ),
          );
        else {
          const nodes: PMNode[] = [];
          text.split('\n').forEach((line, i) => {
            if (i) nodes.push(view.state.schema.nodes.hardBreak.create());
            if (line) nodes.push(view.state.schema.text(line));
          });
          const slice = view.state.schema.nodes.paragraph.create(null, nodes).content;
          view.dispatch(
            view.state.tr.replaceWith(view.state.selection.from, view.state.selection.to, slice),
          );
        }
        return true;
      },
    },
    onUpdate: ({ editor: current, transaction }) => {
      const next = textOf(current.state.doc);
      if (latest.current.maxLength >= 0 && next.length > latest.current.maxLength) {
        current.commands.setContent(transaction.before.toJSON(), { emitUpdate: false });
        return;
      }
      const start = transaction.before.content.findDiffStart(current.state.doc.content) ?? 1;
      const end = transaction.before.content.findDiffEnd(current.state.doc.content)?.a ?? start;
      latest.current.onChange(next, {
        start: textOffset(transaction.before, start),
        end: textOffset(transaction.before, end),
        caret: textOffset(current.state.doc, current.state.selection.from),
      });
    },
    onSelectionUpdate: () => latest.current.onSelect(),
  });
  useLayoutEffect(() => {
    if (!editor || !ready || editor.isDestroyed) return;
    const handle: BotGroupTextInput = {
      element: editor.view.dom,
      get value() {
        return textOf(editor.state.doc);
      },
      get selectionStart() {
        return textOffset(editor.state.doc, editor.state.selection.from);
      },
      get selectionEnd() {
        return textOffset(editor.state.doc, editor.state.selection.to);
      },
      get maxLength() {
        return latest.current.maxLength;
      },
      focus: () => editor.view.dom.focus(),
      setSelectionRange: (start, end) =>
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.create(
              editor.state.doc,
              positionAt(editor.state.doc, start ?? 0),
              positionAt(editor.state.doc, end ?? start ?? 0),
            ),
          ),
        ),
    };
    inputRef.current = handle;
    latest.current.onSelect();
    return () => {
      if (inputRef.current === handle) inputRef.current = null;
    };
  }, [editor, inputRef, ready]);
  useLayoutEffect(() => {
    if (!editor || !ready || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    editor.view.dom.setAttribute('aria-label', label);
    for (const [key, val] of Object.entries(ariaProps)) {
      if (val === undefined) editor.view.dom.removeAttribute(key);
      else editor.view.dom.setAttribute(key, val);
    }
    const current = textOf(editor.state.doc);
    if (current !== value) {
      if (foldRestoredValue) {
        editor.commands.setContent(chipDoc(value), { emitUpdate: false });
        return;
      }
      let start = 0;
      while (start < current.length && start < value.length && current[start] === value[start])
        start++;
      let tail = 0;
      while (
        tail < current.length - start &&
        tail < value.length - start &&
        current[current.length - 1 - tail] === value[value.length - 1 - tail]
      )
        tail++;
      const from = locateTextPosition(editor.state.doc, start);
      const to = locateTextPosition(editor.state.doc, current.length - tail);
      const keepChipText = (text: string): JSONContent[] =>
        isLongPasteText(text)
          ? [chipNode(text)]
          : plainNodes(text);
      // A plain-text edit can cut through a chip (for example, choosing a
      // mention at the end of a restored draft). Replace the whole atom and
      // keep its unaffected text, folding the remaining long parts again.
      const replacement = [
        ...keepChipText(from.insideChip?.text.slice(0, from.insideChip.offset) ?? ''),
        ...plainNodes(value.slice(start, value.length - tail)),
        ...keepChipText(to.insideChip?.text.slice(to.insideChip.offset) ?? ''),
      ];
      const fragment = editor.schema.nodeFromJSON({
        type: 'paragraph',
        content: replacement,
      }).content;
      editor.view.dispatch(
        editor.state.tr
          .replaceWith(
            from.pos,
            to.pos + (to.insideChip?.size ?? 0),
            fragment,
          )
          .setMeta('preventUpdate', true),
      );
    }
  });
  return (
    <>
      <EditorContent
        editor={editor}
        onKeyDownCapture={onKeyDown}
        onPasteCapture={onPaste}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-placeholder={placeholder}
        data-bot-group-composer-loading={!ready && !disabled ? '' : undefined}
      />
      {edit && (
        <ToolPayloadLightbox
          payload={{ kind: 'text', title: t('newChat.pastedText.editTitle'), text: edit.text }}
          textEdit={{
            cancelLabel: t('newChat.pastedText.cancelEdit'),
            saveLabel: t('newChat.pastedText.saveEdit'),
            onSave: (text) => {
              if (
                !editor ||
                !editable ||
                (maxLength >= 0 && value.length - edit.text.length + text.length > maxLength)
              )
                return;
              if (text.length > LONG_PASTE_MAX_CHARS) {
                replacePastedTextChipWithPlainText(editor, edit.pos, edit.text, text);
                return;
              }
              applyPastedTextChipEdit(
                editor,
                edit.pos,
                edit.text,
                text ? { text, display: labelFor(text) } : null,
              );
            },
          }}
          onClose={() => setEdit(null)}
        />
      )}
    </>
  );
}
