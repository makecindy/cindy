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

const addLine = Decoration.line({ class: 'cm-diff-add-line' });
const delLine = Decoration.line({ class: 'cm-diff-del-line' });

/** Outside a hunk, `+++` / `---` denote file headers. */
function lineDecoration(text: string, inHunk: boolean): Decoration | null {
  if (text.startsWith('+') && (inHunk || !text.startsWith('+++'))) return addLine;
  if (text.startsWith('-') && (inHunk || !text.startsWith('---'))) return delLine;
  return null;
}

function buildDecorations(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let oldRemaining = 0;
  let newRemaining = 0;
  let pos = 0;
  for (const text of doc.iterLines()) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
    } else {
      // Non-body metadata ends an incomplete hunk (for example a truncated
      // patch followed by another file). No-newline markers consume no rows.
      if (!/^[ +\\-]/.test(text)) oldRemaining = newRemaining = 0;
      const inHunk = oldRemaining > 0 || newRemaining > 0;
      const deco = lineDecoration(text, inHunk);
      if (deco) builder.add(pos, pos, deco);
      if (inHunk) {
        if (text.startsWith('-') || text.startsWith(' '))
          oldRemaining = Math.max(0, oldRemaining - 1);
        if (text.startsWith('+') || text.startsWith(' '))
          newRemaining = Math.max(0, newRemaining - 1);
      }
    }
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
