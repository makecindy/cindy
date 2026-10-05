/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Run the production initializers and user-intent callback together. Restoring
// history starts unfollowed; the callback deliberately no-ops when already so.
// Testing either state in isolation would miss a permanently hidden indicator.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const names = ['isNearBottomRef', '[isNearBottom, setIsNearBottom]', 'unpinAutoFollowForUserUpIntent'];
const statements = names.map(name => component.body!.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d => d.name.getText(source) === name))!);
const code = ts.transpileModule(statements.map(s => s.getText(source)).join('\n')
  + '\nreturn { isNearBottom, isNearBottomRef, unpinAutoFollowForUserUpIntent };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe('restored history indicator', () => {
  it.each([true, false])('keeps the UI and follow intent aligned when restoring=%s', async (restoring) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    let unpin: () => void = () => {};
    let following = true;
    function Fixture() {
      const restoringRef = useRef(restoring);
      const bindings = { useRef, useState, restoringRef, sessionId: 'history',
        useCallback: (callback: () => void) => callback, bumpSendFollowCancelGeneration: vi.fn() };
      const state = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
      following = state.isNearBottomRef.current;
      unpin = state.unpinAutoFollowForUserUpIntent;
      return <button hidden={state.isNearBottom}>Return to latest</button>;
    }
    try {
      await act(async () => root.render(<Fixture />));
      expect(following).toBe(!restoring);
      expect(host.querySelector('button')!.hidden).toBe(!restoring);
      await act(async () => unpin());
      expect(following).toBe(false);
      expect(host.querySelector('button')!.hidden).toBe(false);
      // Repeated manual input must not be needed to repair an initialization mismatch.
      await act(async () => unpin());
      expect(host.querySelector('button')!.hidden).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
