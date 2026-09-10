/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewportAnchorCorrection } from '../components/chat/messageViewportCompensation';

// Execute the production click listeners and ResizeObserver together, with real
// event propagation and controlled geometry for content inserted above a button.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream');
const effect = component?.body?.statements.find((node) =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
  node.expression.expression.getText(source) === 'useEffect' &&
  node.expression.arguments[0]?.getText(source).includes('const onDisclosureClick'));
if (!effect) throw new Error('Disclosure scroll effect not found');
const code = ts.transpileModule(effect.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const cleanups: Array<() => void> = [];
function setup({ header = false, nearBottom = false } = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  container.scrollTop = 600;
  container.getBoundingClientRect = () => ({ top: 40 }) as DOMRect;
  const content = container.appendChild(document.createElement('div'));
  const button = content.appendChild(document.createElement('button'));
  button.setAttribute('aria-expanded', 'false');
  if (header) button.setAttribute('data-scroll-disclosure-header', '');
  const icon = button.appendChild(document.createElement('span'));
  let documentTop = 1000;
  button.getBoundingClientRect = () => ({ top: documentTop - container.scrollTop }) as DOMRect;
  let resize!: () => void;
  let now = 0;
  const bindings = {
    useEffect: (callback: () => () => void) => cleanups.push(callback()),
    contentRef: { current: content },
    scrollRef: { current: container },
    restoringRef: { current: true },
    suppressHeightCompensationUntilRef: { current: 0 },
    disclosureAnchorRef: { current: null },
    isNearBottomRef: { current: nearBottom },
    CARD_EXPAND_PIN_SUPPRESS_MS: 500,
    CARD_EXPAND_TOGGLE_EVENT: 'xdt-card-expand-toggle',
    Element: window.Element,
    performance: { now: () => now },
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    },
    viewportAnchorCorrection,
    refreshViewportAnchor: vi.fn(),
    refreshHiddenChildViewportAnchor: vi.fn(),
    applyRestoreRef: { current: vi.fn() },
    beginProgrammaticScroll: vi.fn(() => 1),
    finishProgrammaticScroll: vi.fn(),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    pinToBottom: vi.fn(),
    compensateMessageHeight: vi.fn(),
  };
  new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  return {
    container, button, icon, resize, bindings,
    moveButton: (delta: number) => { documentTop += delta; },
    expire: () => { now = 501; },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

describe('disclosure height compensation', () => {
  it.each([false, true])('does not chase a long-message footer after expanding (near bottom: %s)', (nearBottom) => {
    const view = setup({ nearBottom });
    view.icon.click();
    // Revealed message text is above its footer: keeping the footer still would
    // scroll past the beginning of the text the user just chose to read.
    view.moveButton(900);
    view.resize();
    expect(view.container.scrollTop).toBe(600);
    expect(view.bindings.beginProgrammaticScroll).not.toHaveBeenCalled();
    expect(view.bindings.pinToBottom).not.toHaveBeenCalled();
    expect(view.bindings.applyRestoreRef.current).not.toHaveBeenCalled();
    view.expire();
    view.resize();
    expect(nearBottom ? view.bindings.pinToBottom : view.bindings.compensateMessageHeight).toHaveBeenCalledOnce();
  });

  it.each(['click', 'xdt-card-expand-toggle'])('preserves an opted-in header through %s without double compensation', (eventType) => {
    const view = setup({ header: eventType === 'click' });
    if (eventType === 'click') view.icon.click();
    else view.button.dispatchEvent(new CustomEvent(eventType, { bubbles: true }));
    // Simulate native scroll anchoring moving a header when content grows below.
    view.container.scrollTop += 250;
    view.resize();
    expect(view.container.scrollTop).toBe(600);
    view.resize();
    expect(view.container.scrollTop).toBe(600);
    expect(view.bindings.beginProgrammaticScroll).toHaveBeenCalledOnce();
  });
});
