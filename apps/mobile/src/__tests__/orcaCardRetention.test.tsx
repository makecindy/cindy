// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { useFoldableExpandedState, __test_internals } from '@/session/expandedBlockMemory';

// Run the real card and its shared state hook; substitute only native chrome.
const source = ts.createSourceFile('renderer.tsx', readFileSync(resolve(process.cwd(),
  'src/session/MessageRenderer.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const card = source.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'OrcaCollabCard')!;
const compiled = ts.transpileModule(card.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
let generation = 1;
const bindings = {
  React, useFoldableExpandedState, useAuth: () => ({ accountGeneration: generation }),
  useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), makeStyles: () => ({}),
  Bot: () => null, iconSize: {}, iconStroke: {}, Text: 'span', View: 'div',
  CollabCardShell: ({ controlledExpanded, onControlledToggle, children }: {
    controlledExpanded: boolean; onControlledToggle: () => void; children: () => React.ReactNode;
  }) => <button aria-expanded={controlledExpanded} onClick={onControlledToggle}>
    {controlledExpanded ? children() : null}
  </button>,
};
const Card = new Function(...Object.keys(bindings), `${compiled}; return OrcaCollabCard;`)(...Object.values(bindings));

describe('worker card reading state', () => {
  it.each(['report', 'dispatch'])('starts %s collapsed and remembers toggles across remounts, independently per card/account', async (variant) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    __test_internals.reset(); generation = 1;
    const container = document.createElement('div');
    const root = createRoot(container);
    const show = async (key: string) => act(async () => root.render(<Card blockKey={key}
      card={{ variant, title: 'Worker', body: 'Long report' }} />));
    try {
      await show('pc/task/a');
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Long report');
      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Long report');
      await act(async () => root.render(null));
      await show('pc/task/b');
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
      await act(async () => root.render(null));
      await show('pc/task/a');
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Long report');
      generation = 2; await show('pc/task/a');
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
      generation = 1; await show('pc/task/a');
      await act(async () => container.querySelector('button')!.click());
      await act(async () => root.render(null));
      await show('pc/task/a');
      expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Long report');
    } finally { await act(async () => root.unmount()); __test_internals.reset(); }
  });
});
