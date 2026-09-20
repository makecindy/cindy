import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { toRenderItemViewportSnapshot } from '../components/chat/MessageStream';
import { findRenderItemElement, viewportAnchorCorrection } from '../components/chat/messageViewportCompensation';
import { detectScrollAnchoringApplied } from '../components/chat/scrollAnchoringDetect';

const source = readFileSync(resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');
function between(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Missing production scroll block');
  return source.slice(from, to);
}
// Run the production restoration callbacks and history effect against measured
// geometry. Remote details can change total height independently of the anchor.
const compiled = ts.transpileModule(
  between('  const scrollKeyToViewportTop =', '  const restoreViewportSnapshotOrRebuildWindow =') +
    between(
      '  useEffect(() => {\n    const el = scrollRef.current;\n    if (!el || isLoadingMore) return;',
      '\n  // ── 删除靠前 message',
    ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const measureCompiled = ts.transpileModule(
  between('  const measureViewportTop =', '  const refreshViewportAnchor ='),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function run({ targetTop = 42, missing = false, loading = false, exact = false, measuredBeforeTop }: {
  targetTop?: number; missing?: boolean; loading?: boolean; exact?: boolean; measuredBeforeTop?: number;
} = {}) {
  let top = 1058;
  const writes: number[] = [];
  const el = {
    scrollHeight: 38877,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = value;
      writes.push(value);
    },
    getBoundingClientRect: () => ({ top: 0 }),
  };
  let anchorTop = measuredBeforeTop ?? targetTop;
  const target = {
    getAttribute: () => 'anchor',
    getBoundingClientRect: () => ({ top: 1058 + anchorTop - top, bottom: 1158 + anchorTop - top, height: 100 }),
    querySelectorAll: () => [],
  };
  const items = [{ key: 'anchor' }];
  const previousHeight = { current: 38313 };
  const bindings = {
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void) => fn(),
    scrollRef: { current: el },
    itemsRef: { current: { children: missing ? [] : [target] } },
    visibleRenderItemsRef: { current: items },
    visibleRenderItems: items,
    prevScrollHeightRef: previousHeight,
    prevScrollTopAtLoadRef: { current: 282 },
    lastViewportTopRef: {
      current: {
        viewportTopKey: 'anchor',
        offset: 0,
        ...(exact ? { messageClientId: 'message', messageOffset: 0 } : {}),
      },
    },
    isNearBottomRef: { current: false },
    isLoadingMore: loading,
    queryMessageElement: () => (exact && !missing ? target : null),
    pickIntersectingChildAnchor: () => null,
    readViewportChildAnchorClientId: () => null,
    toRenderItemViewportSnapshot,
    detectScrollAnchoringApplied,
    viewportAnchorCorrection,
    findRenderItemElement,
    beginProgrammaticScroll: vi.fn(() => 1),
    finishProgrammaticScroll: vi.fn(),
    requestAnimationFrame: vi.fn(),
  };
  if (measuredBeforeTop !== undefined) {
    bindings.lastViewportTopRef.current = new Function(
      ...Object.keys(bindings), measureCompiled + '\nreturn measureViewportTop();',
    )(...Object.values(bindings));
    anchorTop = targetTop;
  }
  new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return { top, writes, previousHeight: previousHeight.current };
}

describe('history viewport compensation', () => {
  it('keeps an aligned reading row through native scroll events even with null render items', () => {
    let readingTop = 28;
    const estimatedRow = {
      getAttribute: () => 'estimated-row',
      getBoundingClientRect: () => ({ top: -180, bottom: 60, height: 240 }),
      querySelectorAll: () => [],
    };
    const previous = { viewportTopKey: 'reading-row', offset: -28 };
    const readingRow = {
      getAttribute: () => 'reading-row',
      getBoundingClientRect: () => ({ top: readingTop, bottom: readingTop + 100, height: 100 }),
      querySelectorAll: () => [],
    };
    const bindings = {
      useCallback: (fn: unknown) => fn,
      scrollRef: { current: { getBoundingClientRect: () => ({ top: 0, bottom: 700 }) } },
      itemsRef: { current: { children: [estimatedRow, readingRow] } },
      visibleRenderItemsRef: { current: [{ key: 'null-row' }, { key: 'estimated-row' }, { key: 'reading-row' }] },
      lastViewportTopRef: { current: previous },
      findRenderItemElement,
      pickIntersectingChildAnchor: () => null,
      readViewportChildAnchorClientId: () => null,
      viewportAnchorCorrection,
      settleChipJump: vi.fn(),
      chipJumpGenerationRef: { current: null },
      programmaticScrollRef: { current: true },
      programmaticScrollGenerationRef: { current: 1 },
      finishProgrammaticScroll: () => false,
    };
    const captureCode = ts.transpileModule(
      between('  const measureViewportTop =', '  const beginProgrammaticScroll =') +
        between('    const onScrollEnd = () => {\n      settleChipJump();', '\n    root.addEventListener'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const capture = new Function(
      ...Object.keys(bindings), captureCode + '\nonScrollEnd(); return refreshViewportAnchor;',
    )(...Object.values(bindings));
    expect(capture(true)).toBe(previous);
    expect(bindings.lastViewportTopRef.current).toBe(previous);
    readingTop = 400;
    expect(capture(true)).toEqual({ viewportTopKey: 'estimated-row', offset: 180 });
  });
  it.each([
    { measuredBeforeTop: 28, targetTop: 28, expectedTop: 1058 },
    { measuredBeforeTop: 28, targetTop: 282, expectedTop: 1312 },
    { measuredBeforeTop: 7, targetTop: 282, expectedTop: 1333 },
    { measuredBeforeTop: -12, targetTop: 242, expectedTop: 1312 },
  ])('preserves the measured reading position across prepend ($measuredBeforeTop -> $targetTop)',
    ({ measuredBeforeTop, targetTop, expectedTop }) => {
      expect(run({ measuredBeforeTop, targetTop }).top).toBe(expectedTop);
    },
  );
  it.each([false, true])(
    'uses actual anchor displacement, not unrelated total growth (exact=%s)',
    (exact) => {
      expect(run({ exact })).toEqual({ top: 1100, writes: [1100], previousHeight: 0 });
    },
  );
  it('does not compensate twice when the browser already aligned the anchor', () => {
    expect(run({ targetTop: 0 })).toEqual({ top: 1058, writes: [], previousHeight: 0 });
  });
  it('retains the height fallback when the anchor DOM is missing', () => {
    expect(run({ missing: true })).toEqual({ top: 1622, writes: [1622], previousHeight: 0 });
  });
  it('preserves the pending snapshot until loading completes', () => {
    expect(run({ loading: true })).toEqual({ top: 1058, writes: [], previousHeight: 38313 });
  });
});
