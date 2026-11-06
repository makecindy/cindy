// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ definitions: [] as unknown[], ghosts: [] as unknown[] }));
vi.mock('../usePluginShortcutDefinitions', () => ({ usePluginShortcutDefinitions: () => mocks.definitions }));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: () => mocks.ghosts }));

import { PluginUiCommandIcon } from '../PluginUiCommandIcon';

/* Production menu/button icon lookup must not borrow an identically named
 * plugin's image. Existing shortcut tests do not cover instance identity.
 * Minimal failure: two installed instances with the same name. Tier: DOM. */
afterEach(() => { cleanup(); mocks.definitions = []; mocks.ghosts = []; });

describe('plugin command icon', () => {
  it('uses the installed icon of the exact instance, even when plugin names match', () => {
    const first = `plugin:${'a'.repeat(64)}`;
    const second = `plugin:${'b'.repeat(64)}`;
    mocks.definitions = [
      { id: first, instanceId: 'first', pluginName: 'Writer' },
      { id: second, instanceId: 'second', pluginName: 'Writer' },
    ];
    mocks.ghosts = [
      { instanceKey: 'first', manifest: { id: 'writer' }, iconDataUrl: 'data:image/png;base64,AAAA' },
      { instanceKey: 'second', manifest: { id: 'writer' }, iconDataUrl: 'data:image/png;base64,BBBB' },
    ];
    const { container, rerender } = render(<PluginUiCommandIcon shortcutId={first} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    rerender(<PluginUiCommandIcon shortcutId={second} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
  });

  it('does not borrow another instance icon when the matching one is unavailable', () => {
    const id = `plugin:${'a'.repeat(64)}`;
    mocks.definitions = [{ id, instanceId: 'first', pluginName: 'Writer' }];
    mocks.ghosts = [{ instanceKey: 'second', manifest: { id: 'writer' }, iconDataUrl: 'data:image/png;base64,BBBB' }];
    const { container } = render(<PluginUiCommandIcon shortcutId={id} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
