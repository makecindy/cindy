import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { historyPrefetchThreshold } from '@cindy/maker-shared/message-window';
import { decideUserIntentFillAction } from '../components/chat/viewportFillDetect';

const source = readFileSync(resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');
const start = source.indexOf('  const triggerUserIntentFill =');
const end = source.indexOf('\n  useEffect(', start);
const callback = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe('history prefetch', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'uses a bounded fallback for viewport %s',
    (height) => {
      expect(historyPrefetchThreshold(height)).toBe(96);
    },
  );
  it('shares the mobile two-screen threshold', () => {
    expect(historyPrefetchThreshold(754)).toBe(1508);
  });
  it('keeps passive boundary checks narrow while allowing explicit early prefetch', () => {
    const input = {
      scrollTop: 1200,
      scrollHeight: 9000,
      clientHeight: 754,
      windowAtTop: true,
      hasMoreMessages: true,
      isLoadingMore: false,
    };
    expect(decideUserIntentFillAction(input)).toBe('none');
    expect(
      decideUserIntentFillAction({ ...input, triggerDistancePx: historyPrefetchThreshold(754) }),
    ).toBe('load-from-db');
    expect(
      decideUserIntentFillAction({ ...input, isLoadingMore: true, triggerDistancePx: 1508 }),
    ).toBe('none');
    expect(
      decideUserIntentFillAction({ ...input, hasMoreMessages: false, triggerDistancePx: 1508 }),
    ).toBe('none');
    expect(
      decideUserIntentFillAction({ ...input, windowAtTop: false, triggerDistancePx: 1508 }),
    ).toBe('expand-window');
  });
  it.each([true, false])(
    'captures current position and releases same-frame request latch (reject=%s)',
    async (reject) => {
      let settle!: () => void;
      const order: string[] = [];
      const onLoadMore = vi.fn(
        () =>
          new Promise<boolean>((resolve, fail) => {
            order.push('request');
            settle = () => (reject ? fail(new Error('offline')) : resolve(false));
          }),
      );
      const latch = { current: false };
      const bindings = {
        useCallback: (fn: unknown) => fn,
        scrollRef: { current: { scrollTop: 1200, scrollHeight: 9000, clientHeight: 754 } },
        visibleRenderItems: [{}],
        chipJumpInProgressRef: { current: false },
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        historyPrefetchThreshold,
        decideUserIntentFillAction,
        userIntentLoadInFlightRef: latch,
        prevScrollHeightRef: { current: 0 },
        prevScrollTopAtLoadRef: { current: 0 },
        onLoadMore,
        expandWindow: vi.fn(),
        refreshViewportAnchor: () => order.push('anchor'),
      };
      const trigger = new Function(
        ...Object.keys(bindings),
        callback + ';return triggerUserIntentFill;',
      )(...Object.values(bindings));
      trigger();
      trigger();
      expect(order).toEqual(['anchor', 'request']);
      expect(onLoadMore).toHaveBeenCalledTimes(1);
      settle();
      await Promise.resolve();
      expect(latch.current).toBe(false);
      trigger();
      expect(onLoadMore).toHaveBeenCalledTimes(2);
      settle();
      await Promise.resolve();
    },
  );
});
