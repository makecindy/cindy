// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginUiCompletionBridge } from '../PluginUiCompletionBridge';
import type { PluginUiEntry } from '../PluginUiContributions';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
// Unit: real bridge, fake time and IPC only. The pure parser tests do not cover
// input scheduling/lifetime. Minimal input: ordinary text, two queries before
// debounce, then a delayed reply after the trigger disappears. No real waits.
it('debounces triggered input, cancels stale work and ignores its late result', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const invoke = vi.fn(async (_session, input) => input.op === 'plugin-action'
    ? new Promise(resolve => { finish = resolve; }) : {});
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke } });
  const entries = [{ instanceId: 'example', ghost: { manifest: { name: 'Example' } },
    contribution: { id: 'complete', trigger: '@', tool: 'lookup' } }] as PluginUiEntry[];
  const result = vi.fn();
  const view = render(<PluginUiCompletionBridge entries={entries} sessionId={null} request={null} onResult={result} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invoke).not.toHaveBeenCalled();
  result.mockClear();
  const query = (key: string) => <PluginUiCompletionBridge entries={entries} sessionId={null}
    request={{ key, trigger: '@', query: key, from: 1 }} onResult={result} />;
  view.rerender(query('a'));
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(query('ab'));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(invoke).toHaveBeenCalledExactlyOnceWith(null, expect.objectContaining({ op: 'plugin-action', input: { trigger: '@', query: 'ab' } }));
  const requestId = invoke.mock.calls[0][1].requestId;
  view.rerender(<PluginUiCompletionBridge entries={entries} sessionId={null} request={null} onResult={result} />);
  expect(invoke).toHaveBeenLastCalledWith(null, { op: 'plugin-action-cancel', requestId });
  result.mockClear();
  await act(async () => finish({ structuredContent: { items: [{ id: 'one', label: 'Late', insertText: 'late' }] } }));
  expect(result).not.toHaveBeenCalled();
});
