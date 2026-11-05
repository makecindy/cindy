// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

/* The host keeps the original available when a plugin view is selected, fails,
 * or is explicitly changed. Existing control tests do not exercise replacement
 * of a saved record. Minimum failure: a plugin disappears after selection. Tier: DOM. */
const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../usePluginUiContributions', () => ({ usePluginUiContributions: () => state.current }));
vi.mock('../ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: true }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../PluginUiControls', () => ({ PluginUiControls: () => <div>Plugin content</div> }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect(): void }) => <button onClick={onSelect}>{children}</button>,
}));
import { PluginUiRendererView } from '../PluginUiRendererView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps the host original available and lets the user choose an offered renderer', () => {
  const chooseRenderer = vi.fn();
  state.current = { views: [], renderer: { candidates: [{ instanceId: 'plugin', contributionId: 'body', pluginName: 'Example' }] },
    chooseRenderer, pending: new Set(), invoke: vi.fn(), disabled: false };
  const props = { sessionId: 'task', point: 'message.body' as const, target: { kind: 'message', id: 'message' } };
  const { rerender } = render(<PluginUiRendererView {...props}><div>Original text</div></PluginUiRendererView>);
  expect(screen.getByText('Original text')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Example · body' }));
  expect(chooseRenderer).toHaveBeenCalledWith({ instanceId: 'plugin', contributionId: 'body' });
  state.current = { ...state.current, views: [{ viewId: 'view', revision: '1' }],
    renderer: { candidates: [{ instanceId: 'plugin', contributionId: 'body', pluginName: 'Example' }], selected: { instanceId: 'plugin', contributionId: 'body' } } };
  rerender(<PluginUiRendererView {...props}><div>Original text</div></PluginUiRendererView>);
  expect(screen.getByText('Plugin content')).toBeTruthy();
  expect(screen.getByText('Original text').closest('details')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pluginUi.original' }));
  expect(chooseRenderer).toHaveBeenLastCalledWith(null);
  state.current = { ...state.current, views: [] };
  rerender(<PluginUiRendererView {...props}><div>Original text</div></PluginUiRendererView>);
  expect(screen.queryByText('Plugin content')).toBeNull();
  expect(screen.getByText('Original text').closest('details')).toBeNull();
});

it('opens a selected read-only page while keeping the original accessible', async () => {
  const openPage = vi.fn().mockResolvedValue('98a39be7-0e86-4bb4-a3ad-57b04035bc57');
  const closePage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { ghosts: { ui: { openPage, closePage } } });
  state.current = { views: [{ viewId: 'view', revision: '1', contributionId: 'body', page: true }],
    renderer: { candidates: [], selected: { instanceId: 'plugin', contributionId: 'body' } },
    chooseRenderer: vi.fn(), pending: new Set(), invoke: vi.fn(), disabled: true };
  render(<PluginUiRendererView sessionId="task" point="message.body" target={{ kind: 'message', id: 'message' }}>
    <div>Original text</div>
  </PluginUiRendererView>);
  expect(await screen.findByTitle('body')).toBeTruthy();
  expect(openPage).toHaveBeenCalledWith({ sessionId: 'task', viewId: 'view', revision: '1' });
  expect(screen.getByText('Original text').closest('details')).toBeTruthy();
});
