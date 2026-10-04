/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { expect, it, vi } from 'vitest';

// Execute the real callback against React commits: the old history window and
// the latest window have different heights. A source-string contract would not
// detect measuring the old DOM before React finishes switching windows.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const statement = component.body!.statements.find(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(d => d.name.getText(source) === 'scrollToBottomSmooth'))!;
const code = ts.transpileModule(statement.getText(source) + '\nreturn scrollToBottomSmooth;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it('measures the latest window after its React commit when jumping out of history', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  let jump: () => void = () => {};
  const scroll = vi.fn();
  function Fixture() {
    const [firstKey, setFirstVisibleItemKey] = useState<string | null>('old-history');
    const scrollRef = useRef<HTMLDivElement>(null);
    const bindings = {
      useCallback: (callback: () => void) => callback, flushSync, scrollRef,
      restoringRef: { current: false }, cancelFocusJump: vi.fn(),
      chipJumpGenerationRef: { current: null }, finishChipJump: vi.fn(),
      setUnreadCount: vi.fn(), setIsNearBottom: vi.fn(), isNearBottomRef: { current: false },
      beginProgrammaticScroll: () => 1, setFirstVisibleItemKey,
      syncMessageViewport: vi.fn(),
      finishProgrammaticScroll: () => false, refreshViewportAnchor: vi.fn(), CHIP_JUMP_SAFETY_MS: 1000,
    };
    jump = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    return <div ref={scrollRef} data-window={firstKey ?? 'latest'} />;
  }
  try {
    await act(async () => root.render(<Fixture />));
    const element = host.firstElementChild as HTMLDivElement;
    Object.defineProperty(element, 'scrollHeight', { get: () => element.dataset.window === 'latest' ? 8000 : 3000 });
    element.scrollTo = scroll;
    await act(async () => jump());
    expect(element.dataset.window).toBe('latest');
    expect(scroll).toHaveBeenCalledWith({ top: 8000, behavior: 'smooth' });
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers();
  }
});
