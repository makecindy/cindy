// @vitest-environment jsdom
/**
 * PR #10019: exercise the production diffLineHighlight extension through an
 * EditorView. Existing markdown tests do not cover diff-file row backgrounds.
 * Minimal regression: a hunk containing +++counter; and ---- must paint both
 * changed rows, while file headers remain plain. Tier: unit (in-memory DOM).
 * Kept separate from fence tests because those need no EditorView/DOM lifecycle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { diffLineHighlight } from '../codemirrorDiffLines';

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function openDiff(doc: string) {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ doc, extensions: [diffLineHighlight], parent });
  views.push(view);
  return view;
}

function changedRows(view: EditorView) {
  return [...view.dom.querySelectorAll('.cm-diff-add-line, .cm-diff-del-line')]
    .map(row => [row.textContent, row.classList.contains('cm-diff-add-line') ? 'add' : 'del']);
}

describe('diff-file row backgrounds', () => {
  it('distinguishes header-like changes inside a hunk from file headers', () => {
    const view = openDiff('--- a/file\n+++ b/file\n@@ -1 +1 @@\n----\n+++counter;');
    expect(changedRows(view)).toEqual([['----', 'del'], ['+++counter;', 'add']]);
  });

  it('ends hunk context before the next file headers, even without diff --git', () => {
    const view = openDiff('--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+++counter;');
    expect(changedRows(view)).toEqual([['-old', 'del'], ['+new', 'add'], ['+++counter;', 'add']]);
  });

  it('rebuilds hunk context after editing the document', () => {
    const view = openDiff('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new');
    const from = view.state.doc.line(4).from;
    view.dispatch({ changes: { from, to: view.state.doc.length, insert: '----\n+++counter;' } });
    expect(changedRows(view)).toEqual([['----', 'del'], ['+++counter;', 'add']]);
  });
});
