/**
 * Full-row diff colours for `.diff` / `.patch` files opened in CodeMirror
 * (DESIGN.md §2 "Diff Add Green / Diff Del Red": DiffView, ```diff blocks and
 * diff files share the `--diff-*` tokens, painted across the whole row).
 *
 * The legacy diff stream parser only tags tokens; a token background stops at
 * the last glyph, so the rows are decorated as lines instead. Only visible
 * ranges are scanned, so large patches stay cheap.
 */

import { type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const addLine = Decoration.line({ class: 'cm-diff-add-line' });
const delLine = Decoration.line({ class: 'cm-diff-del-line' });

/** `+++` / `---` are file headers, not changed rows. */
function lineDecoration(text: string): Decoration | null {
  if (text.startsWith('+') && !text.startsWith('+++')) return addLine;
  if (text.startsWith('-') && !text.startsWith('---')) return delLine;
  return null;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const deco = lineDecoration(line.text);
      if (deco) builder.add(line.from, line.from, deco);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const diffLinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const diffLineTheme = EditorView.theme({
  '.cm-diff-add-line': { backgroundColor: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)' },
  '.cm-diff-del-line': { backgroundColor: 'var(--diff-del-bg)', color: 'var(--diff-del-fg)' },
});

export const diffLineHighlight: Extension = [diffLinePlugin, diffLineTheme];

export function isDiffLanguage(language: string | undefined): boolean {
  const normalized = language?.toLowerCase();
  return normalized === 'diff' || normalized === 'patch';
}
