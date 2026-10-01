// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MountOnFirstOpen } from '@/session/MountOnFirstOpen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('skips closed content, then preserves the sheet instance and draft through close/reopen', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const mounted = vi.fn(), unmounted = vi.fn();
  let edit: (value: string) => void = () => {};
  function Sheet({ open }: { open: boolean }) {
    const [draft, setDraft] = useState('initial');
    edit = setDraft;
    useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
    return <span data-open={open}>{draft}</span>;
  }
  const content = vi.fn((open: boolean) => <Sheet open={open} />);
  const render = (open: boolean) => act(() => root.render(
    <MountOnFirstOpen open={open}>{() => content(open)}</MountOnFirstOpen>,
  ));
  try {
    render(false);
    expect(content).not.toHaveBeenCalled();
    render(true);
    act(() => edit('draft'));
    render(false);
    expect(container.querySelector('span')?.dataset.open).toBe('false');
    expect(container.textContent).toBe('draft');
    expect(unmounted).not.toHaveBeenCalled();
    render(true);
    expect(container.textContent).toBe('draft');
    expect(mounted).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
  expect(unmounted).toHaveBeenCalledOnce();
});
