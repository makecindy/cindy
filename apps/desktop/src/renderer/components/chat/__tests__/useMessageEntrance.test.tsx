// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageEntrance } from '../useMessageEntrance';

// Unit regression for the real DOM entrance hook: history and stream updates must not replay;
// the existing action-bar tests do not mount arriving rows or exercise reduced-motion changes.
const animate = vi.fn();
const cancel = vi.fn();
let reduced: MediaQueryList;
let onChange: (() => void) | undefined;
function Timeline({ keys, visible = keys, ready = true }: { keys: string[]; visible?: string[]; ready?: boolean }) {
  const enter = useMessageEntrance(keys, ready);
  return <>{visible.map(key => <div key={key} ref={node => enter(node, key)}
    style={{ '--motion-base': '200ms', '--motion-ease-out': 'ease-out' } as React.CSSProperties}>{key}</div>)}</>;
}
beforeEach(() => {
  animate.mockReset(); cancel.mockReset(); onChange = undefined;
  animate.mockReturnValue({ cancel, finished: new Promise(() => {}) });
  vi.stubGlobal('matchMedia', vi.fn(() => reduced));
  vi.stubGlobal('getComputedStyle', (node: HTMLElement) => node.style);
  reduced = { matches: false, addEventListener: (_: string, listener: () => void) => { onChange = listener; },
    removeEventListener: vi.fn() } as unknown as MediaQueryList;
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => { vi.unstubAllGlobals(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; });

it('animates a live append once, retaining the same node across streaming and acknowledgement', () => {
  const view = render(<Timeline keys={['history']} />);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<Timeline keys={['history', 'reply']} />);
  const node = view.getByText('reply');
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(<Timeline keys={['history', 'reply']} />);
  expect(view.getByText('reply')).toBe(node);
  expect(animate).toHaveBeenCalledTimes(1);
});

it('does not animate initial async history, prepends or virtualization remounts', () => {
  const view = render(<Timeline keys={[]} ready={false} />);
  view.rerender(<Timeline keys={['history']} />);
  view.rerender(<Timeline keys={['older', 'history']} />);
  expect(animate).not.toHaveBeenCalled();
  const keys = ['older', 'history', 'reply'];
  view.rerender(<Timeline keys={keys} />);
  view.rerender(<Timeline keys={keys} visible={['history']} />);
  view.rerender(<Timeline keys={keys} />);
  expect(animate).toHaveBeenCalledTimes(1);
});

it('keeps messages immediate under reduced motion and stops an entrance when the preference changes', () => {
  const view = render(<Timeline keys={[]} />);
  Object.assign(reduced, { matches: true });
  view.rerender(<Timeline keys={['first']} />);
  expect(animate).not.toHaveBeenCalled();
  Object.assign(reduced, { matches: false });
  view.rerender(<Timeline keys={['first', 'next']} />);
  expect(animate).toHaveBeenCalledTimes(1);
  Object.assign(reduced, { matches: true }); onChange?.();
  expect(cancel).toHaveBeenCalledTimes(1);
});
