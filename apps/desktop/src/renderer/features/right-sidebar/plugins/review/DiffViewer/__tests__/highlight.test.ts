// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useMemo } from 'react';
import type { FileDiff } from '@/lib/gitReview.types';
import { buildDiffRows } from '../diffRows';
import { getCachedHighlight, highlightLine } from '../highlight';
import { useDiffHighlights } from '../useDiffHighlights';

type WorkerListener = (event: MessageEvent | ErrorEvent) => void;

class MockHighlightWorker {
  static instances: MockHighlightWorker[] = [];

  readonly listeners = new Map<string, WorkerListener[]>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    MockHighlightWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitError(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener(new ErrorEvent('error', { message }));
    }
  }

  respond(html: string): void {
    const request = this.postMessage.mock.calls.at(-1)![0];
    for (const listener of this.listeners.get('message') ?? []) {
      listener(new MessageEvent('message', { data: { id: request.id, ok: true, html } }));
    }
  }
}

describe('DiffViewer highlight worker', () => {
  afterEach(() => {
    cleanup();
    for (const worker of MockHighlightWorker.instances) worker.emitError('test finished');
    vi.unstubAllGlobals();
    MockHighlightWorker.instances = [];
  });

  it('terminates and recreates the worker after an error', async () => {
    vi.stubGlobal('Worker', MockHighlightWorker);

    const first = highlightLine('typescript', 'const first = 1;');
    expect(MockHighlightWorker.instances).toHaveLength(1);
    MockHighlightWorker.instances[0].emitError('worker crashed');
    await expect(first).resolves.toBeNull();
    expect(MockHighlightWorker.instances[0].terminate).toHaveBeenCalledTimes(1);

    void highlightLine('typescript', 'const second = 2;');
    expect(MockHighlightWorker.instances).toHaveLength(2);
  });

  // Unit regression: revisiting a diff must show its cached highlighting on the
  // first render, without replacing plain text in a second accessibility update.
  // Existing worker tests did not cover the hook's unmount/remount lifecycle.
  // PR #8490: after a cached remount, evict the shared cache and refresh identical
  // rows. Every render must retain highlighting, avoiding a plain-text AX update.
  it('reuses cached highlighting on the first render after returning to a diff', async () => {
    vi.stubGlobal('Worker', MockHighlightWorker);
    const content = 'const revisited = 1;';
    const html = '<span class="hljs-keyword">const</span> revisited = 1;';
    const diff: FileDiff = {
      id: 'unstaged:revisited.ts', source: 'unstaged', path: 'revisited.ts', oldPath: null,
      status: 'modified', kind: 'text', size: null, additions: 1, deletions: 0,
      isBinary: false, isSubmodule: false, isTooLarge: false,
      mode: { old: null, new: null }, index: { oldOid: null, newOid: null },
      rawHeader: '', rawPatch: '', error: null,
      hunks: [{
        index: 0, header: '@@ -0,0 +1 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1,
        section: '', raw: '', selectableLines: [0],
        lines: [{ index: 0, type: 'add', content, raw: `+${content}`, oldLineNumber: null,
          newLineNumber: 1, originalLineNumber: 1, selectable: true, noTrailingNewLine: false }],
      }],
    };
    const rows = buildDiffRows(diff.hunks, 'unified');
    const first = renderHook(() => useDiffHighlights(diff, rows));
    expect(first.result.current.size).toBe(0);
    await act(async () => { MockHighlightWorker.instances[0].respond(html); });
    expect(first.result.current.get('0:0')).toBe(html);
    first.unmount();

    const rendered: Array<string | undefined> = [];
    const returned = renderHook(({ value }) => {
      const currentRows = useMemo(() => buildDiffRows(value.hunks, 'unified'), [value.hunks]);
      const highlights = useDiffHighlights(value, currentRows);
      rendered.push(highlights.get('0:0'));
      return highlights;
    }, { initialProps: { value: diff } });
    expect(rendered[0]).toBe(html);

    // Fill the real shared LRU through its production entry point; no fake timers
    // or module reset can substitute for the eviction that caused this regression.
    for (let i = 0; i < 2000; i += 1) {
      const otherContent = `const cachePressure${i} = 0;`;
      const pending = highlightLine('typescript', otherContent);
      MockHighlightWorker.instances[0].respond(otherContent);
      await pending;
    }
    expect(getCachedHighlight('typescript', content)).toBeUndefined();
    const beforeRefresh = rendered.length;
    returned.rerender({ value: structuredClone(diff) });
    expect(rendered.slice(beforeRefresh).every((value) => value === html)).toBe(true);

    const changed = structuredClone(diff);
    changed.hunks[0].lines[0].content = 'const revisited = 2;';
    returned.rerender({ value: changed });
    expect(returned.result.current.has('0:0')).toBe(false);
    await act(async () => { MockHighlightWorker.instances[0].respond('const revisited = 2;'); });
    expect(returned.result.current.get('0:0')).toBe('const revisited = 2;');
  });
});
