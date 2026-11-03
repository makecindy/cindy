/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { usePrevUserMessageInView } from '../components/chat/usePrevUserMessageInView';

// Render the actual placeholder expression: the navigation hook and click handler
// must find a user message even while its body is outside the mounted viewport.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression = '';
function visit(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.attributes.properties.some(
    p => ts.isJsxAttribute(p) && p.name.getText(source) === 'data-message-placeholder',
  )) expression = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
const renderPlaceholder = new Function('React', 'item', 'messageViewport', ts.transpileModule(
  `return (${expression});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
).outputText);

it('finds an offscreen question through its real placeholder, without mounting its body', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++sequence, cb); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.hasAttribute('data-message-placeholder') ? -300 : 0;
    return { top, bottom: top + 100, height: 100 } as DOMRect;
  });
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  let target: string | null = null;
  function Fixture() {
    const scrollRef = useRef<HTMLDivElement>(null);
    target = usePrevUserMessageInView({ scrollRef, userMessageIds: ['question'], resetKey: 'test' }).displayId;
    return <div ref={scrollRef}>{renderPlaceholder(React,
      { key: 'msg-question', type: 'message', message: { clientId: 'question', role: 'user' } },
      { placeholderHeight: () => 100 },
    )}</div>;
  }
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(16)); });
    expect(target).toBe('question');
    const placeholder = host.querySelector('[data-user-msg-id="question"]');
    expect(placeholder?.hasAttribute('data-message-placeholder')).toBe(true);
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder?.textContent).toBe('');
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

it.each([
  { clientId: 'assistant', role: 'assistant' },
  { clientId: 'synthetic', role: 'user', isSyntheticTrigger: true },
])('does not offer a question target for $clientId', message => {
  const placeholder = renderPlaceholder(React, { key: message.clientId, type: 'message', message },
    { placeholderHeight: () => 100 });
  expect(placeholder.props['data-user-msg-id']).toBeUndefined();
});
