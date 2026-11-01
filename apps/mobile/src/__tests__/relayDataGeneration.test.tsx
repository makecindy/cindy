// @vitest-environment jsdom
// Unit: the production lifecycle hook must retire Home reads on route changes
// even when auth stays signed in. Existing relay tests only covered connection routing.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const route = vi.hoisted(() => ({ generation: 0, listeners: new Set<() => void>() }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({
  getSelfHostedRelayRouteGeneration: () => route.generation,
  subscribeSelfHostedRelayRoute: (listener: () => void) => {
    route.listeners.add(listener);
    return () => { route.listeners.delete(listener); };
  },
}));
import { useRelayDataGeneration } from '@/device-link/useRelayDataGeneration';

it('retires data generations for either account or route changes, but not ordinary rerenders', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  const root = createRoot(element);
  function Screen({ account }: { account: number }) {
    return <span>{useRelayDataGeneration(account)}</span>;
  }
  try {
    act(() => root.render(<Screen account={7} />));
    const first = element.textContent;
    act(() => { route.generation++; route.listeners.forEach(fn => fn()); });
    const second = element.textContent;
    expect(second).not.toBe(first);
    act(() => root.render(<Screen account={7} />));
    expect(element.textContent).toBe(second);
    act(() => root.render(<Screen account={8} />));
    const third = element.textContent;
    expect(third).not.toBe(second);
    act(() => { route.generation++; route.listeners.forEach(fn => fn()); });
    expect(element.textContent).not.toBe(third);
  } finally {
    act(() => root.unmount());
  }
});
