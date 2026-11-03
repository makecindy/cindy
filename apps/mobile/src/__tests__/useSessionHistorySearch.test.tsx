// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useSessionHistorySearch } from '@/session/useSessionHistorySearch';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('opens on reused-route requests without reopening a dismissed request', async () => {
  const root = createRoot(document.createElement('div'));
  let result!: ReturnType<typeof useSessionHistorySearch>;
  function Probe({ open, request }: { open: string | null; request: string | null }) {
    result = useSessionHistorySearch(open, request);
    return null;
  }
  const render = async (open: string | null, request: string | null) => {
    await act(async () => root.render(createElement(Probe, { open, request })));
  };
  try {
    await render(null, null); expect(result[0]).toBe(false);
    await render('1', 'first'); expect(result[0]).toBe(true);
    await act(async () => result[1](false));
    await render('1', 'first'); expect(result[0]).toBe(false);
    await render('1', 'second'); expect(result[0]).toBe(true);
    await act(async () => result[1](false));
    await render('1', 'second'); expect(result[0]).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
