/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('MessageStream.tsx', readFileSync(
  resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'MessageStream')!;
const effect = component.body!.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect' &&
  node.getText(source).includes("root.addEventListener('scrollend', onScrollEnd)")) as ts.ExpressionStatement;
const callback = (effect.expression as ts.CallExpression).arguments[0];
const code = ts.transpileModule(`return (${callback.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

function fixture() {
  const root = document.createElement('div');
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const focusJumpRef = { current: {} as object | null };
  const bindings = {
    scrollRef: { current: root }, focusJumpRef, settleFocusJump: vi.fn(),
    cancelFocusJump: () => { focusJumpRef.current = null; },
    isScrollNavigationKey: () => true, isEditableKeyboardTarget: () => false,
  };
  const cleanup = new Function(...Object.keys(bindings), code)(...Object.values(bindings))();
  cleanups.push(cleanup);
  return { ...bindings, root, cleanup, frame: () => frames.splice(0).forEach(callback => callback(0)) };
}

it('waits for pending layout frames before final focus correction', () => {
  const f = fixture();
  f.root.dispatchEvent(new Event('scrollend'));
  f.frame();
  expect(f.settleFocusJump).not.toHaveBeenCalled();
  f.frame();
  expect(f.settleFocusJump).toHaveBeenCalledOnce();
});

it('does not treat each animated scroll write as the end of the focus jump', () => {
  const f = fixture();
  f.focusJumpRef.current = { cancelAnimation: vi.fn() };
  f.root.dispatchEvent(new Event('scrollend'));
  f.frame(); f.frame();
  expect(f.settleFocusJump).not.toHaveBeenCalled();
});

it.each(['wheel', 'replacement', 'unmount'])('does not recenter after %s takes ownership', action => {
  const f = fixture();
  f.root.dispatchEvent(new Event('scrollend'));
  f.frame();
  if (action === 'wheel') f.root.dispatchEvent(new Event('wheel'));
  else if (action === 'replacement') f.focusJumpRef.current = {};
  else f.cleanup();
  f.frame();
  expect(f.settleFocusJump).not.toHaveBeenCalled();
});

it('keeps the generic scrollend listener from finishing a focus-owned generation', () => {
  const f = fixture();
  const genericEffect = component.body!.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect' &&
    node.getText(source).includes('settleChipJump();')) as ts.ExpressionStatement;
  const callback = (genericEffect.expression as ts.CallExpression).arguments[0];
  const genericCode = ts.transpileModule(`return (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const bindings = {
    scrollRef: { current: f.root }, focusJumpRef: f.focusJumpRef,
    settleChipJump: vi.fn(), chipJumpGenerationRef: { current: null },
    programmaticScrollRef: { current: true }, programmaticScrollGenerationRef: { current: 7 },
    finishProgrammaticScroll: vi.fn(() => false), refreshViewportAnchor: vi.fn(),
  };
  cleanups.push(new Function(...Object.keys(bindings), genericCode)(...Object.values(bindings))());
  f.root.dispatchEvent(new Event('scrollend'));
  expect(bindings.finishProgrammaticScroll).not.toHaveBeenCalled();
  f.frame();f.frame();
  expect(f.settleFocusJump).toHaveBeenCalledOnce();
  f.focusJumpRef.current = null;
  f.root.dispatchEvent(new Event('scrollend'));
  expect(bindings.finishProgrammaticScroll).toHaveBeenCalledWith(7);
});

function settlement() {
  const declaration = component.body!.statements.flatMap(node => ts.isVariableStatement(node)
    ? [...node.declarationList.declarations] : []).find(node => node.name.getText(source) === 'settleFocusJump')!;
  const callback = (declaration.initializer as ts.CallExpression).arguments[0];
  const body = ts.transpileModule(`return (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const root = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  const target = { scrollIntoView: () => { root.scrollTop = 1000; },
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }), dataset: { messageClientId: 'target' } };
  const jump = { clientId: 'target', requestKey: '1:target', targetKey: 'msg-target',
    messageClientIdsAtJump: [], scrollGeneration: 7 };
  const bindings = {
    focusJumpRef: { current: jump as typeof jump | null }, focusScrollTimerRef: { current: null },
    focusHighlightTimerRef: { current: null }, programmaticScrollGenerationRef: { current: 7 },
    deferredDeleteCompensationRef: { current: false }, scrollRef: { current: root },
    setHighlightMessageClientId: vi.fn(), allRenderItemsRef: { current: [] },
    queryFocusElement: () => target, syncMessageViewport: vi.fn(),
    refreshViewportAnchor: vi.fn(() => ({ viewportTopKey: 'msg-target', offset: 0 })),
    finishProgrammaticScroll: vi.fn(() => false),
  };
  return { ...bindings, root, jump, settle: new Function(...Object.keys(bindings), body)(...Object.values(bindings)) as () => void,
    frame: () => frames.splice(0).forEach(callback => callback(0)) };
}

it('corrects a late native offset before releasing search ownership', () => {
  const f = settlement();
  f.settle();f.frame();
  expect(f.root.scrollTop).toBe(1000);
  expect(f.finishProgrammaticScroll).not.toHaveBeenCalled();
  f.root.scrollTop = 1800; // Native correction arrives after the first alignment.
  f.frame();
  expect(f.root.scrollTop).toBe(1000);
  f.frame();f.frame();
  expect(f.finishProgrammaticScroll).not.toHaveBeenCalled();
  f.frame();
  expect(f.finishProgrammaticScroll).toHaveBeenCalledOnce();
  expect(f.focusJumpRef.current).toBeNull();
});

it('does not undo a user position after cancellation during layout settling', () => {
  const f = settlement();
  f.settle();
  f.focusJumpRef.current = null;
  f.root.scrollTop = 800;
  f.frame();
  expect(f.root.scrollTop).toBe(800);
  expect(f.finishProgrammaticScroll).not.toHaveBeenCalled();
});
