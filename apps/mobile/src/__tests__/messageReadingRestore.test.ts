import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the production initial-position effect with a deterministic native list boundary.
const source = ts.createSourceFile('renderer.tsx', readFileSync(resolve(process.cwd(),
  'src/session/MessageRenderer.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect = '';
let correction = '';
let paddingEffect = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes('const prev = prevTopPaddingRef.current;')) {
    paddingEffect = node.arguments[0].getText(source);
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useLayoutEffect'
    && node.arguments[0]?.getText(source).includes('const savedKey =')) {
    effect = node.arguments[0].getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'reconcileReopeningAnchor'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    correction = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);

function restore(focused: string | null = null, key = 'message') {
  const scrollToIndex = vi.fn();
  const scrollToEndProgrammatically = vi.fn();
  const bindings = {
    initialAnchorDoneRef: { current: false },
    listData: [{ key: 'message' }],
    initialRevealProgress: { setValue: vi.fn() },
    setListRevealed: vi.fn(),
    initialRevealGenerationRef: { current: 0 },
    initialRevealAnimationRef: { current: null },
    Animated: { timing: () => ({ start: vi.fn() }) },
    MOBILE_INITIAL_REVEAL_MAX_MS: 300,
    Easing: { step1: vi.fn() },
    focusedItemKeyRef: { current: focused },
    reopeningPosition: { atEnd: false, anchor: { key, viewportOffset: -37 } },
    mobileMessageHistoryRowKeyByIdentity: vi.fn(),
    nearBottomRef: { current: true },
    setIsAwayFromBottom: vi.fn(),
    markProgrammaticScroll: vi.fn(),
    reopeningAnchorRef: { current: null },
    reconcileReopeningAnchor: vi.fn(),
    listRef: { current: { scrollToIndex } },
    scrollToEndProgrammatically,
  };
  expect(effect).not.toBe('');
  const compiled = ts.transpileModule(`const run = ${effect};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function(...Object.keys(bindings), `${compiled}\nrun();`)(...Object.values(bindings));
  return { ...bindings, scrollToIndex };
}

describe('initial reading position', () => {
  it('restores the saved message offset without first jumping to the end', () => {
    const result = restore();
    expect(result.scrollToIndex).toHaveBeenCalledWith({ animated: false, index: 0,
      viewPosition: 0, viewOffset: -37 });
    expect(result.scrollToEndProgrammatically).not.toHaveBeenCalled();
    expect(result.nearBottomRef.current).toBe(false);
  });
  it('leaves explicit message-link navigation in control', () => {
    expect(restore('link-target').scrollToIndex).not.toHaveBeenCalled();
  });
  it('falls back to latest when the saved row is no longer in cached history', () => {
    const result = restore(null, 'removed');
    expect(result.scrollToIndex).not.toHaveBeenCalled();
    expect(result.scrollToEndProgrammatically).toHaveBeenCalledWith(false);
    expect(result.nearBottomRef.current).toBe(true);
  });
});

describe('reading position after real row measurements', () => {
  function setup() {
    let frame: (() => void) | undefined;
    const scrollToOffset = vi.fn();
    const list = { scrollLength: 600, scroll: 200, data: [{ key: 'saved' }], sizeAtIndex: vi.fn((): number | undefined => undefined) };
    const bindings = {
      historyPositioningRef: { current: true },
      reopeningAnchorRef: { current: { anchor: { key: 'saved', viewportOffset: -30 }, expires: Date.now() + 1500, corrections: 0 } as null | { anchor: object; expires: number; corrections: number } },
      reopeningFrameRef: { current: null as number | null },
      requestAnimationFrame: vi.fn((callback: () => void) => { frame = callback; return 1; }),
      listRef: { current: { getState: () => list, scrollToOffset } },
      mobileMessageHistoryRowKeyByIdentity: vi.fn(),
      resolveMobileMessageHistoryAnchorOffset: vi.fn(() => 830),
      getCurrentHistoryTopOffsetAdjustment: vi.fn(() => 32),
      MOBILE_ANCHOR_VERIFY_TOLERANCE: 2,
      markProgrammaticScroll: vi.fn(),
    };
    const compiled = ts.transpileModule(`const run = ${correction};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const run = new Function(...Object.keys(bindings), `${compiled}\nreturn run;`)(...Object.values(bindings));
    return { ...bindings, list, run, scrollToOffset, flush: () => { const callback = frame; frame = undefined; callback?.(); } };
  }
  it('waits for measurements, coalesces layout events, and stops commanding once aligned', () => {
    const r = setup();
    r.run(); r.flush(); expect(r.scrollToOffset).not.toHaveBeenCalled();
    r.list.sizeAtIndex.mockReturnValue(1000);
    r.run(); r.run(); r.flush();
    expect(r.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 830, animated: false });
    r.list.scroll = 830;
    r.run(); r.flush(); expect(r.scrollToOffset).toHaveBeenCalledTimes(1);
  });
  it('does not fight a user gesture or keep correcting later dynamic content', () => {
    const r = setup(); r.list.sizeAtIndex.mockReturnValue(1000);
    r.run(); r.reopeningAnchorRef.current = null; r.flush();
    expect(r.scrollToOffset).not.toHaveBeenCalled();
    r.reopeningAnchorRef.current = { anchor: { key: 'saved' }, expires: Date.now() - 1, corrections: 0 };
    r.run(); r.flush(); expect(r.scrollToOffset).not.toHaveBeenCalled();
    expect(r.reopeningAnchorRef.current).toBeNull();
  });
});


describe('top padding during bookmark restoration', () => {
  function run(restoring: boolean, sequence = 1, nearBottom = false) {
    const bindings = {
      prevTopPaddingRef: { current: 0 }, topPadding: 90,
      nearBottomRef: { current: nearBottom }, readingOlderRef: { current: false },
      reopeningAnchorRef: { current: restoring ? { anchor: {} } : null },
      reconcileReopeningAnchor: vi.fn(), initialAnchorDoneRef: { current: true },
      nativeScrollEventSequenceRef: { current: sequence },
      scrollMetricsRef: { current: { offsetY: sequence ? 600 : 0 } },
      scrollToOffsetProgrammatically: vi.fn(),
    };
    expect(paddingEffect).not.toBe('');
    const compiled = ts.transpileModule(`const run = ${paddingEffect};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function(...Object.keys(bindings), `${compiled}\nrun();`)(...Object.values(bindings));
    expect(bindings.prevTopPaddingRef.current).toBe(90);
    return bindings;
  }
  it('lets the bookmark resolver own positioning instead of cancelling its index seek', () => {
    const r = run(true, 0);
    expect(r.reconcileReopeningAnchor).toHaveBeenCalledOnce();
    expect(r.scrollToOffsetProgrammatically).not.toHaveBeenCalled();
  });
  it('does not compensate using an unobserved native offset', () => {
    expect(run(false, 0).scrollToOffsetProgrammatically).not.toHaveBeenCalled();
  });
  it('still compensates a measured reading position after restoration', () => {
    expect(run(false).scrollToOffsetProgrammatically).toHaveBeenCalledWith(690, false);
  });
  it('leaves latest-message positioning to the tail follower', () => {
    expect(run(false, 1, true).scrollToOffsetProgrammatically).not.toHaveBeenCalled();
  });
});
