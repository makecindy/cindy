/**
 * Full-row diff colours for `.diff` / `.patch` files opened in CodeMirror
 * (DESIGN.md §2 "Diff Add Green / Diff Del Red": DiffView, ```diff blocks and
 * diff files share the `--diff-*` tokens, painted across the whole row).
 *
 * The legacy diff stream parser only tags tokens; a token background stops at
 * the last glyph, so the rows are decorated as lines instead. Documents are
 * scanned on edits; cached ranges retain hunk context when its header scrolls
 * out of view, without rescanning on viewport changes.
 */

import { type Extension, RangeSetBuilder, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { classifyDiffLines } from './diffLineClassification';

const addLine = Decoration.line({ class: 'cm-diff-add-line' });
const delLine = Decoration.line({ class: 'cm-diff-del-line' });

function buildDecorations(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const { text, type } of classifyDiffLines(doc.iterLines())) {
    const deco = type === 'add' ? addLine : type === 'del' ? delLine : null;
    if (deco) builder.add(pos, pos, deco);
    pos += text.length + 1;
  }
  return builder.finish();
}

const diffLineField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state.doc);
  },
  update(decorations, transaction) {
    return transaction.docChanged ? buildDecorations(transaction.state.doc) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const diffLineTheme = EditorView.theme({
  '.cm-diff-add-line': { backgroundColor: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)' },
  '.cm-diff-del-line': { backgroundColor: 'var(--diff-del-bg)', color: 'var(--diff-del-fg)' },
});

export const diffLineHighlight: Extension = [diffLineField, diffLineTheme];

export function isDiffLanguage(language: string | undefined): boolean {
  const normalized = language?.toLowerCase();
  return normalized === 'diff' || normalized === 'patch';
}
