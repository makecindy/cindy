// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRef, useState } from 'react';

import { Switch } from '../switch';

function renderSwitch(): { track: HTMLElement; thumb: HTMLElement } {
  render(<Switch aria-label="Background updates" />);
  const track = screen.getByRole('switch', { name: 'Background updates' });
  return { track, thumb: track.firstElementChild as HTMLElement };
}

describe('Switch', () => {
  afterEach(cleanup);

  it('uses dedicated semantic tokens for both track states and the thumb', () => {
    const { track, thumb } = renderSwitch();
    expect(track.className).toContain('data-[state=unchecked]:bg-[var(--switch-track-off)]');
    expect(thumb.className).toContain('data-[state=unchecked]:bg-[var(--switch-thumb-off)]');
    expect(thumb.className).toContain('data-[state=checked]:bg-[var(--switch-thumb-on)]');
    expect(track.className).toContain('data-[state=checked]:bg-[var(--switch-track-on)]');
  });

  it('keeps the thumb flat and clearly mutes the disabled state', () => {
    const { track, thumb } = renderSwitch();
    // §6 零阴影哲学:滑块不得带任何投影(2026-08-05 用户裁决,试过可见投影后显式否决)
    expect(thumb.className).not.toContain('shadow');
    // 禁用态两级弱化必须走皮肤可覆盖的 token,不得回退硬编码 opacity(定值见 colors.ts)
    expect(track.className).toContain('disabled:opacity-[var(--switch-disabled-opacity)]');
    expect(thumb.className).toContain(
      'data-[disabled]:opacity-[var(--switch-disabled-thumb-opacity)]',
    );
  });
});

// jsdom supplies neither pointer capture nor layout. Only those browser inputs
// are supplied here; the real Radix component, click path and form input run.
describe('Switch input compatibility', () => {
  beforeEach(() => {
    document.documentElement.style.fontSize = '16px';
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'PointerEvent',
      class extends MouseEvent {
        pointerId: number;
        pointerType: string;
        isPrimary: boolean;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
          this.isPrimary = init.isPrimary ?? true;
        }
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.style.fontSize = '';
  });

  function prepare(track: HTMLElement) {
    let captured: number | null = null;
    Object.defineProperties(track, {
      offsetWidth: { value: 36 },
      clientWidth: { value: 32 },
      clientLeft: { value: 2 },
      setPointerCapture: {
        value: vi.fn((id: number) => {
          captured = id;
        }),
      },
      hasPointerCapture: { value: (id: number) => captured === id },
      releasePointerCapture: {
        value: vi.fn(() => {
          captured = null;
        }),
      },
    });
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 36 } as DOMRect);
    vi.spyOn(track.firstElementChild!, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          left: track.dataset.state === 'checked' ? 118 : 102,
        }) as DOMRect,
    );
    return track;
  }
  function drag(track: HTMLElement, delta: number, end = 'up') {
    fireEvent.pointerDown(track, { clientX: 106, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 106 + delta, pointerId: 1 });
    if (end === 'cancel') fireEvent.pointerCancel(track, { pointerId: 1 });
    else if (end === 'escape') fireEvent.keyDown(track, { key: 'Escape' });
    else if (end === 'capture') fireEvent.lostPointerCapture(track, { pointerId: 1 });
    else fireEvent.pointerUp(track, { pointerId: 1 });
    fireEvent.click(track, { detail: 1 });
  }

  it('retains the forwarded button ref, labels, uncontrolled state and form value', () => {
    const ref = createRef<HTMLButtonElement>();
    const changed = vi.fn();
    const { container } = render(
      <form>
        <label htmlFor="test-switch">Notifications</label>
        <Switch
          id="test-switch"
          name="notifications"
          defaultChecked
          ref={ref}
          onCheckedChange={changed}
        />
      </form>,
    );
    const track = screen.getByRole('switch');
    expect(ref.current).toBe(track);
    expect(track.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Notifications'));
    expect(changed.mock.calls).toEqual([[false]]);
    expect(
      (container.querySelector('input[name="notifications"]') as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.click(track, { detail: 0 }); // keyboard-style activation
    expect(changed.mock.calls).toEqual([[false], [true]]);
  });

  it('commits each drag once through the controlled callback and form event', () => {
    const changed = vi.fn(),
      formChanged = vi.fn();
    function Controlled() {
      const [checked, setChecked] = useState(false);
      return (
        <form onChange={formChanged}>
          <Switch
            name="setting"
            checked={checked}
            onCheckedChange={(next) => {
              changed(next);
              setChecked(next);
            }}
          />
        </form>
      );
    }
    render(<Controlled />);
    const track = prepare(screen.getByRole('switch'));
    drag(track, 24);
    expect(track.dataset.state).toBe('checked');
    expect(changed.mock.calls).toEqual([[true]]);
    expect(formChanged).toHaveBeenCalledTimes(1);
    drag(track, -24);
    expect(track.dataset.state).toBe('unchecked');
    expect(changed.mock.calls).toEqual([[true], [false]]);
    expect(formChanged).toHaveBeenCalledTimes(2);
  });

  it('does not change a controlled value until its owner accepts it', () => {
    const changed = vi.fn();
    render(<Switch checked={false} onCheckedChange={changed} />);
    const track = prepare(screen.getByRole('switch'));
    drag(track, 24);
    expect(changed.mock.calls).toEqual([[true]]);
    expect(track.dataset.state).toBe('unchecked');
    expect((track.firstElementChild as HTMLElement).style.getPropertyValue('--switch-drag-x')).toBe(
      '',
    );
  });

  it.each(['up', 'cancel', 'escape', 'capture'])(
    'does not toggle on a same-side or cancelled drag (%s)',
    (end) => {
      const changed = vi.fn();
      render(<Switch onCheckedChange={changed} />);
      const track = prepare(screen.getByRole('switch'));
      drag(track, end === 'up' ? 3 : 24, end);
      expect(changed).not.toHaveBeenCalled();
      expect(track.dataset.state).toBe('unchecked');
      expect(track.firstElementChild?.hasAttribute('data-dragging')).toBe(false);
      // A cancelled pointer interaction must not swallow a later keyboard click.
      fireEvent.click(track, { detail: 0 });
      expect(changed.mock.calls).toEqual([[true]]);
    },
  );

  it('cancels an active gesture when disabled and stays inert', () => {
    const changed = vi.fn();
    const { rerender } = render(<Switch onCheckedChange={changed} />);
    const track = prepare(screen.getByRole('switch'));
    fireEvent.pointerDown(track, { clientX: 106 });
    fireEvent.pointerMove(track, { clientX: 130 });
    rerender(<Switch disabled onCheckedChange={changed} />);
    fireEvent.pointerUp(track);
    fireEvent.click(track);
    expect(changed).not.toHaveBeenCalled();
    expect(track.firstElementChild?.hasAttribute('data-dragging')).toBe(false);
    expect((track as HTMLButtonElement).hasPointerCapture(1)).toBe(false);
  });

  it('does not swallow a later label activation after pointer cancellation', () => {
    const changed = vi.fn();
    render(
      <>
        <label htmlFor="cancelled-switch">Notifications</label>
        <Switch id="cancelled-switch" onCheckedChange={changed} />
      </>,
    );
    const track = prepare(screen.getByRole('switch'));
    fireEvent.pointerDown(track, { clientX: 106 });
    fireEvent.pointerMove(track, { clientX: 130 });
    fireEvent.pointerCancel(track);
    // Browsers do not dispatch click after pointercancel. The next label
    // activation is a separate interaction, with no pointerdown on the Switch.
    const label = screen.getByText('Notifications');
    fireEvent.pointerDown(label);
    fireEvent.pointerUp(label);
    fireEvent.click(label, { detail: 1 });
    expect(changed.mock.calls).toEqual([[true]]);
  });

  it('respects consumer event cancellation for pointer gestures and clicks', () => {
    const changed = vi.fn();
    const { rerender } = render(
      <Switch onCheckedChange={changed} onPointerDown={(event) => event.preventDefault()} />,
    );
    const track = prepare(screen.getByRole('switch'));
    fireEvent.pointerDown(track, { clientX: 106 });
    expect((track as HTMLButtonElement).setPointerCapture).not.toHaveBeenCalled();
    rerender(<Switch onCheckedChange={changed} onClick={(event) => event.preventDefault()} />);
    drag(track, 24);
    expect(changed).not.toHaveBeenCalled();
  });
});
