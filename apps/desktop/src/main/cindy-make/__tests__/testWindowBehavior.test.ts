import { describe, expect, it, vi } from 'vitest';
import { createMakeTestWindowBehavior } from '../testWindowBehavior';

describe('Cindy Make test window', () => {
  const environment = { XDT_CINDY_MAKE_TEST: '1', XDT_ISOLATED: '1' };

  it('activates the ready preview and quits on close without persisting a tray preference', () => {
    const focus = vi.fn();
    const quit = vi.fn();
    const window = createMakeTestWindowBehavior({ isPackaged: false, environment, focus, quit });
    expect(focus).not.toHaveBeenCalled();
    window.ready();
    expect(focus).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    expect(window.close(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledBefore(quit);
    expect(quit).toHaveBeenCalledOnce();
  });

  it.each([
    { isPackaged: true, environment },
    { isPackaged: false, environment: {} },
    { isPackaged: false, environment: { XDT_ISOLATED: '1' } },
    { isPackaged: false, environment: { XDT_CINDY_MAKE_TEST: '1' } },
    { isPackaged: false, environment: { ...environment, XDT_CINDY_MAKE_TEST: '0' } },
  ])('preserves normal activation and close behavior for %j', (options) => {
    const focus = vi.fn();
    const quit = vi.fn();
    const window = createMakeTestWindowBehavior({ ...options, focus, quit });
    window.ready();
    const event = { preventDefault: vi.fn() };
    expect(window.close(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
