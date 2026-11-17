// @vitest-environment jsdom
// #8998: exercise the real preview + production sidebar listener; existing gesture
// tests do not cover document -> window propagation. Fake time covers preview exit.
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MermaidLightbox } from '../../chat/MermaidLightbox';
import { useRightSidebarMaximizeEscape } from '../useRightSidebarMaximizeEscape';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Public diagram</text></svg>';
function Layers() {
  const [maximized, setMaximized] = useState(true);
  const [preview, setPreview] = useState(true);
  useRightSidebarMaximizeEscape(maximized, () => setMaximized(false));
  return <>
    <output data-testid="maximized">{String(maximized)}</output>
    {preview && <MermaidLightbox svg={svg} onClose={() => setPreview(false)} />}
  </>;
}
function escape(target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('right sidebar Escape ownership', () => {
  it('closes only Mermaid, retains maximize during exit, then exits on the next press', () => {
    vi.useFakeTimers();
    render(<Layers />);
    const overlay = document.querySelector('[data-mermaid-lightbox-overlay]')!;
    expect(escape(overlay).defaultPrevented).toBe(true);
    expect(screen.getByTestId('maximized').textContent).toBe('true');
    act(() => { vi.advanceTimersByTime(199); });
    escape(overlay);
    expect(screen.getByTestId('maximized').textContent).toBe('true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('[data-mermaid-lightbox-overlay]')).toBeNull();
    expect(escape().defaultPrevented).toBe(true);
    expect(screen.getByTestId('maximized').textContent).toBe('false');
  });

  it('consumes standalone maximize Escape and removes its listener on disable/unmount', () => {
    const onExit = vi.fn();
    const hook = renderHook(({ enabled }) => useRightSidebarMaximizeEscape(enabled, onExit), { initialProps: { enabled: true } });
    expect(escape().defaultPrevented).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: false });
    expect(escape().defaultPrevented).toBe(false);
    hook.unmount();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not take an already-consumed Escape or cancel editing', () => {
    const onExit = vi.fn();
    renderHook(() => useRightSidebarMaximizeEscape(true, onExit));
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    claimed.preventDefault();
    act(() => { document.body.dispatchEvent(claimed); });
    const input = document.createElement('input');
    document.body.append(input);
    escape(input);
    input.remove();
    expect(onExit).not.toHaveBeenCalled();
  });

  it.each(['data-lightbox-layer', 'data-morph-side', 'modal-dialog'])('yields to a mounted foreground %s even before it consumes the key', (attribute) => {
    const onExit = vi.fn();
    renderHook(() => useRightSidebarMaximizeEscape(true, onExit));
    const foreground = document.createElement('div');
    if (attribute === 'modal-dialog') {
      foreground.setAttribute('role', 'dialog');
      foreground.setAttribute('aria-modal', 'true');
    } else foreground.setAttribute(attribute, '');
    document.body.append(foreground);
    try {
      escape();
      expect(onExit).not.toHaveBeenCalled();
    } finally { foreground.remove(); }
  });

  it('does not treat a persistent non-modal dialog as a blocking layer', () => {
    const onExit = vi.fn();
    renderHook(() => useRightSidebarMaximizeEscape(true, onExit));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    try {
      escape();
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally { dialog.remove(); }
  });

  it.each([{ repeat: true }, { isComposing: true }, { ctrlKey: true }])('ignores held, composing or modified Escape %j', (init) => {
    const onExit = vi.fn();
    renderHook(() => useRightSidebarMaximizeEscape(true, onExit));
    escape(document.body, init);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('leaves Mermaid open for a consumed key or a newer lightbox', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<MermaidLightbox svg={svg} onClose={onClose} />);
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    claimed.preventDefault();
    act(() => { document.body.dispatchEvent(claimed); });
    const foreground = document.createElement('div');
    foreground.setAttribute('data-lightbox-layer', '');
    document.body.append(foreground);
    try {
      escape(foreground);
      act(() => { vi.advanceTimersByTime(200); });
      expect(onClose).not.toHaveBeenCalled();
    } finally { foreground.remove(); }
  });
});
