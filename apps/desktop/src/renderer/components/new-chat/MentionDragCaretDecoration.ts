import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface MentionDragCaretState {
  pos: number | null;
  decorations: DecorationSet;
}

const PLUGIN_KEY = new PluginKey<MentionDragCaretState>('mentionDragCaretDecoration');
const META_KEY = 'mentionDragCaretDecoration';
const caretPositionByEditor = new WeakMap<Editor, number | null>();

function buildDecorations(doc: EditorState['doc'], pos: number | null): DecorationSet {
  if (pos === null) return DecorationSet.empty;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const caret = Decoration.widget(
    clamped,
    () => {
      const el = document.createElement('span');
      el.setAttribute('data-mention-drag-caret', 'true');
      el.style.display = 'inline-block';
      el.style.width = '0';
      el.style.height = '22px';
      el.style.margin = '0 var(--space-px)';
      el.style.borderLeft = '2px solid var(--chat-input-border-focus)';
      el.style.verticalAlign = 'text-bottom';
      el.style.pointerEvents = 'none';
      return el;
    },
    { key: `mention-drag-caret-${clamped}`, side: -1 },
  );
  return DecorationSet.create(doc, [caret]);
}

export function setMentionDragCaret(editor: Editor | null, pos: number | null): void {
  if (!editor) return;
  caretPositionByEditor.set(editor, pos);
  if (editor.isDestroyed) return;
  const state = PLUGIN_KEY.getState(editor.state);
  if (state?.pos === pos) return;
  editor.view.dispatch(editor.state.tr.setMeta(META_KEY, { pos }));
}

export function getMentionDragCaretPosition(editor: Editor): number | null {
  return PLUGIN_KEY.getState(editor.state)?.pos ?? caretPositionByEditor.get(editor) ?? null;
}

export const MentionDragCaretDecoration = Extension.create({
  name: 'mentionDragCaretDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin<MentionDragCaretState>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            return { pos: null, decorations: buildDecorations(state.doc, null) };
          },
          apply(tr: Transaction, old: MentionDragCaretState) {
            const meta = tr.getMeta(META_KEY) as { pos?: number | null } | undefined;
            const mappedPos =
              old.pos === null ? null : tr.mapping.map(old.pos, -1);
            const nextPos = meta && Object.prototype.hasOwnProperty.call(meta, 'pos')
              ? meta.pos ?? null
              : mappedPos;
            if (!tr.docChanged && nextPos === old.pos) return old;
            return { pos: nextPos, decorations: buildDecorations(tr.doc, nextPos) };
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
