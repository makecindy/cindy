// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginUiView } from '@cindy/maker-shared';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../usePluginUiContributions', () => ({ usePluginUiContributions: () => state.current }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginUiContributionControls } from '../PluginUiControls';
import { usePluginUiVisibilityOwner } from '../usePluginUiVisibility';
import type { PluginUiVisibilityApplication } from '../../../shared/pluginUiVisibility';

const view: PluginUiView = { version: 1, viewId: 'view', contributionId: 'settings', point: 'composer.tools',
  revision: '1', page: true, controls: [{ kind: 'button', id: 'open', label: 'Open plugin', actionId: 'open' }],
  actions: [{ id: 'open', label: 'Open plugin' }], blocks: [], fallbackMarkdown: 'Plugin unavailable' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens a plugin page only on demand and closes it when the contribution becomes unavailable', async () => {
  const openPage = vi.fn().mockResolvedValue('98a39be7-0e86-4bb4-a3ad-57b04035bc57');
  const closePage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { ghosts: { ui: { openPage, closePage } } });
  state.current = { views: [view], pending: new Set(), invoke: vi.fn(), disabled: false };
  const { rerender } = render(<PluginUiContributionControls sessionId="task" point="composer.tools" />);
  expect(openPage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open plugin' }));
  expect(await screen.findByTitle('settings')).toBeTruthy();
  state.current = { ...state.current, views: [], disabled: true };
  rerender(<PluginUiContributionControls sessionId="task" point="composer.tools" />);
  await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId: '98a39be7-0e86-4bb4-a3ad-57b04035bc57' }));
  expect(screen.queryByTitle('settings')).toBeNull();
});

// User report: a body-portaled plugin page outlived workspace hiding.
// Real visibility projection and controlled Popover must close its page mount.
it('closes the plugin popover with the workspace and keeps it closed after restore', async () => {
  let apply!: (request: PluginUiVisibilityApplication) => void;
  const visible = { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true };
  const openPage = vi.fn().mockResolvedValue('98a39be7-0e86-4bb4-a3ad-57b04035bc57');
  const closePage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { ghosts: { ui: { openPage, closePage } }, pluginUiVisibility: {
    get: async () => visible, onApply: (fn: typeof apply) => { apply = fn; return () => {}; },
    applied: async () => {}, release: async () => {},
  } });
  state.current = { views: [view], pending: new Set(), invoke: vi.fn(), disabled: false };
  function Preview() { usePluginUiVisibilityOwner(); return <PluginUiContributionControls sessionId="task" point="composer.tools" />; }
  render(<Preview />);
  fireEvent.click(screen.getByRole('button', { name: 'Open plugin' }));
  await screen.findByTitle('settings');
  act(() => apply({ requestId: 'hide', values: { ...visible, workspace: false } }));
  await waitFor(() => expect(closePage).toHaveBeenCalledExactlyOnceWith({ pageId: '98a39be7-0e86-4bb4-a3ad-57b04035bc57' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => apply({ requestId: 'restore', values: visible }));
  expect(screen.queryByTitle('settings')).toBeNull();
});
