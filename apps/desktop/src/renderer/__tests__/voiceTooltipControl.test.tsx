// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  open: undefined as boolean | undefined,
  change: (_open: boolean) => {},
}));
// Exercise Tip's controlled/hover bridge; Radix's pointer timing is external.
vi.mock('@radix-ui/react-tooltip', () => ({
  Provider: ({ children }: { children: React.ReactNode }) => children,
  Root: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => {
    bridge.open = open;
    bridge.change = onOpenChange;
    return children;
  },
  Trigger: ({ children }: { children: React.ReactNode }) => children,
  Portal: ({ children }: { children: React.ReactNode }) => children,
  Content: ({ children }: { children: React.ReactNode }) => children,
}));

import { Tip } from '../components/ui/tooltip';
afterEach(cleanup);

it.each([false, true])(
  'does not revive an old hover after forced open=%s is released',
  (forced) => {
    const view = (controlledOpen?: boolean, text = 'Stop') => (
      <Tip text={text} controlledOpen={controlledOpen} resetHoverOnControlChange>
        <button>Mic</button>
      </Tip>
    );
    const h = render(view());
    act(() => bridge.change(true));
    expect(bridge.open).toBe(true);
    h.rerender(view(forced, 'Confirming'));
    act(() => bridge.change(true)); // pointer remains on the disabled trigger
    expect(bridge.open).toBe(forced);
    h.rerender(view(undefined, 'Start'));
    expect(bridge.open).toBe(false);
    act(() => bridge.change(true)); // a new hover still works
    expect(bridge.open).toBe(true);
  },
);

it('does not change the default hover handoff for other tooltips', () => {
  const view = (controlledOpen?: boolean) => (
    <Tip text="Other" controlledOpen={controlledOpen}>
      <button>Other</button>
    </Tip>
  );
  const h = render(view());
  act(() => bridge.change(true));
  h.rerender(view(false));
  h.rerender(view());
  expect(bridge.open).toBe(true);
});
