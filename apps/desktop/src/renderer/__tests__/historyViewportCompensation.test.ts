import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { toRenderItemViewportSnapshot } from '../components/chat/MessageStream';
import { detectScrollAnchoringApplied } from '../components/chat/scrollAnchoringDetect';

const source = readFileSync(resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8');
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

function run({ targetTop = 42, missing = false, loading = false, exact = false } = {}) {
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
  const target = { getBoundingClientRect: () => ({ top: 1058 + targetTop - top }) };
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
    toRenderItemViewportSnapshot,
    detectScrollAnchoringApplied,
    beginProgrammaticScroll: vi.fn(() => 1),
    finishProgrammaticScroll: vi.fn(),
    requestAnimationFrame: vi.fn(),
  };
  new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return { top, writes, previousHeight: previousHeight.current };
}

describe('history viewport compensation', () => {
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
