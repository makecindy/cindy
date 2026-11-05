// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePluginUiVisibilityOwner } from '../usePluginUiVisibility';
import type { PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';

const visible: PluginUiVisibilityValues = { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true };
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'electronAPI'); });
describe('plugin visibility projection', () => {
  // User report: workspace=false left the explicitly visible sidebar on screen.
  // The parent switch must mask area visibility without erasing separate choices.
  it('projects the workspace switch onto its areas and preserves their choices on restore', async () => {
    let request!: (value: { requestId: string; values: PluginUiVisibilityValues }) => void;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { pluginUiVisibility: {
      get: async () => ({ ...visible, sidebar: false }),
      onApply: (fn: typeof request) => { request = fn; return () => {}; },
      applied: async () => {}, release: async () => {},
    } } });
    const hook = renderHook(usePluginUiVisibilityOwner);
    await act(async () => {});
    act(() => request({ requestId: 'hide', values: { ...visible, sidebar: false, workspace: false } }));
    expect(Object.values(hook.result.current).every(value => value === false)).toBe(true);
    expect(document.documentElement.dataset.pluginUiHidden?.split(' ')).toContain('sidebar');
    act(() => request({ requestId: 'restore', values: { ...visible, sidebar: false } }));
    expect(hook.result.current).toEqual({ ...visible, sidebar: false });
  });
  it('applies hide and restore and ignores a stale initial snapshot', async () => {
    let request!: (value: { requestId: string; values: PluginUiVisibilityValues }) => void;
    let initial!: (value: PluginUiVisibilityValues) => void;
    const applied = vi.fn(async () => {});
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { pluginUiVisibility: {
      get: () => new Promise(resolve => { initial = resolve; }),
      onApply: (fn: typeof request) => { request = fn; return () => {}; }, applied, release: async () => {},
    } } });
    const hook = renderHook(usePluginUiVisibilityOwner);
    act(() => request({ requestId: 'hide', values: { ...visible, workspace: false } }));
    expect(hook.result.current.workspace).toBe(false);
    expect(document.documentElement.dataset.pluginUiHidden).toContain('workspace');
    await act(async () => { initial(visible); await Promise.resolve(); });
    expect(hook.result.current.workspace).toBe(false);
    act(() => request({ requestId: 'show', values: visible }));
    expect(hook.result.current.workspace).toBe(true);
    expect(document.documentElement.dataset.pluginUiHidden).toBe('');
  });
});
