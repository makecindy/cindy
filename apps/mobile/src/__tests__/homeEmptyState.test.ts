import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { shouldReplaceListWithSearchResults } from '@/session/conversationSearch';

// Unit regression, PR #10674: execute Home's production ListEmptyComponent JSX.
// The search hook tests never render this branch. Minimal failure: an indexed
// search excludes a locally matching pinned task; no-results must remain visible.
// The full Home requires native navigation/store providers; isolate this render
// expression as deviceDetailProjectHeaderLayout does, without copying its JSX.
// Single-file validation: 2.21s; the search+ready+pinned case fails before the fix.
const source = ts.createSourceFile('HomeSurface.tsx', readFileSync(
  resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression = '';
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === 'ListEmptyComponent'
    && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    expression = node.initializer.expression.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!expression) throw new Error('Missing Home empty-state render expression');
const compiled = ts.transpileModule(`const result = ${expression};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
}).outputText;
const Empty = ({ title }: { title: string }) => createElement('p', null, title);
const Loading = () => createElement('p', null, 'loading');

it.each([
  ['', 'idle', true, ''],
  ['needle', 'ready', true, '<p>no matching tasks</p>'],
  ['needle', 'searching', true, '<p>loading</p>'],
  ['', 'idle', false, '<p>no matching tasks</p>'],
] as const)('renders query=%s status=%s with pinned=%s', (searchQuery, status, pinned, expected) => {
  const bindings = {
    createElement, shouldReplaceListWithSearchResults, searchQuery, indexedSearch: { status },
    sharedRows: [], initialHomeLoading: status === 'searching', taskSuggestionsPending: false,
    filteredHome: { pinned: pinned ? [{}] : [] }, showRemoteGuide: false,
    contentFilterCount: 0, taskSuggestionsMode: null, initialHomeError: false,
    emptyStateTitle: 'no matching tasks', emptyStateCopy: 'adjust search',
    spacing: { xxl: 32 }, windowLayout: { emptyMinHeight: 100, emptyPadding: 16 },
    MainWindowEmptyState: Empty, HomeInitialLoadingState: Loading,
  };
  const result = new Function(...Object.keys(bindings), `${compiled}\nreturn result;`)(...Object.values(bindings));
  expect(renderToStaticMarkup(result ?? null)).toBe(expected);
});
