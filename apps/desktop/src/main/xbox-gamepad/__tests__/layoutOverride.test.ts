import { describe, expect, it } from 'vitest';

import {
  cloneXboxGamepadLayout,
  createXboxGamepadDefaultLayout,
} from '../../../shared/xboxGamepad.js';
import { xboxGamepadLayoutOverrides } from '../layoutOverride.js';

describe('xboxGamepadLayoutOverrides', () => {
  it('persists only the remapped control so later defaults still apply', () => {
    const defaults = createXboxGamepadDefaultLayout();
    const layout = cloneXboxGamepadLayout(defaults);
    layout.buttons.a = { type: 'command', commandId: 'newTask' };

    expect(xboxGamepadLayoutOverrides(layout, defaults)).toEqual({
      version: 1,
      buttons: { a: { type: 'command', commandId: 'newTask' } },
      sticks: {},
    });
  });

  it('persists an explicit unbind as null instead of omitting the key', () => {
    const defaults = createXboxGamepadDefaultLayout();
    const layout = cloneXboxGamepadLayout(defaults);
    layout.buttons.x = null;

    expect(xboxGamepadLayoutOverrides(layout, defaults)?.buttons).toEqual({ x: null });
  });

  it('stores nothing when the layout still matches the live defaults', () => {
    const defaults = createXboxGamepadDefaultLayout();
    expect(xboxGamepadLayoutOverrides(cloneXboxGamepadLayout(defaults), defaults)).toBeNull();
  });
});
