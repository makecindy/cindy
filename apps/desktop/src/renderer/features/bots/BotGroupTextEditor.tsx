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
import type { BotGroupTextInput } from './botGroupTextInput';

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

function positionAt(doc: PMNode, offset: number): number {
  let result = doc.content.size - 1;
  doc.descendants((node, pos) => {
    if (!node.isText && node.type.name !== 'pastedTextChip' && node.type.name !== 'hardBreak')
      return;
    const start = textOffset(doc, pos);
    if (offset >= start && offset <= start + textOf(node).length) {
      result = node.isText ? pos + offset - start : pos + (offset === start ? 0 : node.nodeSize);
      return false;
    }
  });
  return Math.max(1, result);
}

export function BotGroupTextEditor({
  value,
  initialPaste,
  inputRef,
  disabled,
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
  initialPaste?: { before: string; text: string; selected: string; after: string } | null;
  inputRef: RefObject<BotGroupTextInput | null>;
  disabled: boolean;
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
  const latest = useRef({ onChange, onSelect, maxLength, disabled, placeholder });
  latest.current = { onChange, onSelect, maxLength, disabled, placeholder };
  const [edit, setEdit] = useState<{ pos: number; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  const labelFor = (text: string) =>
    t('newChat.pastedText.chipLabel', { lines: countPasteLines(text) });
  const plainNodes = (text: string): JSONContent[] =>
    text
      .split('\n')
      .flatMap((line, i) => [
        ...(i ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]);
  const editor = useEditor({
    immediatelyRender: false,
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
      : isLongPasteText(value)
        ? {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'pastedTextChip', attrs: { text: value, display: labelFor(value) } },
                ],
              },
            ],
          }
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
        class: `${BOT_GROUP_COMPOSER_INPUT} whitespace-pre-wrap`,
      },
      handleClickOn: (_view, _pos, node, nodePos) => {
        if (node.type.name !== 'pastedTextChip' || latest.current.disabled) return false;
        setEdit({ pos: nodePos, text: node.attrs.text });
        return true;
      },
      handlePaste: (view, event) => {
        if (latest.current.disabled) {
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
    editor.setEditable(!disabled, false);
    editor.view.dom.setAttribute('aria-label', label);
    for (const [key, val] of Object.entries(ariaProps)) {
      if (val === undefined) editor.view.dom.removeAttribute(key);
      else editor.view.dom.setAttribute(key, val);
    }
    const current = textOf(editor.state.doc);
    if (current !== value) {
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
      const replacement = plainNodes(value.slice(start, value.length - tail));
      const fragment = editor.schema.nodeFromJSON({
        type: 'paragraph',
        content: replacement,
      }).content;
      editor.view.dispatch(
        editor.state.tr
          .replaceWith(
            positionAt(editor.state.doc, start),
            positionAt(editor.state.doc, current.length - tail),
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
                disabled ||
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
