// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginShortcutDefinition } from '../../../shared/appShortcuts';
import { usePluginShortcutDefinitions } from '../usePluginShortcutDefinitions';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('plugin shortcut declarations', () => {
  it('tracks the existing shortcut channel when a plugin is enabled or disabled', async () => {
    const definition: PluginShortcutDefinition = {
      id: `plugin:${'a'.repeat(64)}`, label: 'Format', pluginName: 'Writer', scope: 'message',
    };
    let changed!: (payload: { pluginShortcuts: unknown }) => void;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        appShortcuts: {
          getState: () => ({ pluginShortcuts: [definition, { id: 'plugin:invalid' }] }),
          onChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
        },
      },
    });
    const { result } = renderHook(usePluginShortcutDefinitions);
    expect(result.current).toEqual([definition]);
    act(() => changed({ pluginShortcuts: [] }));
    expect(result.current).toEqual([]);
  });
});
