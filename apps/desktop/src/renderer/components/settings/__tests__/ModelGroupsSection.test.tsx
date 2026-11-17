// @vitest-environment jsdom

// #10608 / unit: real settings component + production save client, injected owner IPC.
// Overview tests cover quota display, not strategy disclosure or save timing/errors.
// Minimum regressions: one mode, delayed or rejected set, and overlapping queued saves.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ModelGroupsConfig } from '../../../../shared/modelGroups';
import { toast } from '@/lib/toast';

const translation = { t: (key: string) => key, i18n: { language: 'en' } };
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ModelSelector: () => null, ProviderMark: () => null }));
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({ devices: [] }) }));
vi.mock('../ModelGroupsOverview', () => ({ ModelGroupsOverview: () => null }));
vi.mock('../ModelGroupRouteExceptions', () => ({ ModelGroupRouteExceptions: () => null }));
vi.mock('@/features/model-groups/modelGroupsClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/model-groups/modelGroupsClient')>(),
  useModelGroupCandidateNames: () => () => ({ modelName: 'Test', sourceLabel: 'Test', connected: true }),
}));
import { ModelGroupsSection } from '../ModelGroupsSection';

let config: ModelGroupsConfig;
let set: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // jsdom has no layout scrolling; keep the real Radix Select interaction.
  Element.prototype.scrollIntoView = vi.fn();
  config = { routes: [{ id: 'test-mode', name: 'Test mode', strategy: 'order', candidates: [] }] };
  set = vi.fn(async (next: ModelGroupsConfig) => { config = next; return next; });
  Object.assign(window, { electronAPI: { modelGroups: { get: vi.fn(async () => config), set } } });
});
async function openDetail() {
  render(<ModelGroupsSection />);
  fireEvent.click(await screen.findByText('Test mode'));
  await screen.findByTestId('model-group-route-detail');
}
async function choose(strategy: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'modelGroups.settings.pick' }));
  fireEvent.click(await screen.findByRole('option', { name: `modelGroups.strategy.${strategy}.title` }));
}

it('opens explanations for exactly the supported model-group strategies without hover', async () => {
  await openDetail();
  const disclosure = screen.getByRole('button', { name: 'subscriptionAccounts.strategyHelp.details' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  const panel = document.getElementById(disclosure.getAttribute('aria-controls')!)!;
  for (const strategy of ['expiring', 'order', 'rotate', 'cheapest']) {
    expect(within(panel).getByText(`modelGroups.strategy.${strategy}.hint`)).toBeTruthy();
  }
  await waitFor(() => expect(within(panel).getAllByRole('heading')).toHaveLength(4));
  expect(screen.getByText('modelGroups.settings.strategyLimits')).toBeTruthy();
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
});
it('announces saved and the next-selection scope only after the host receipt', async () => {
  let finish!: (next: ModelGroupsConfig) => void;
  set.mockImplementationOnce(() => new Promise<ModelGroupsConfig>(resolve => { finish = resolve; }));
  await openDetail();
  await choose('rotate');
  await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('status')).toBeNull();
  const next = set.mock.calls[0][0];
  await act(async () => { finish(next); });
  expect(screen.getByRole('status').textContent).toContain('subscriptionAccounts.strategyHelp.saved');
  expect(screen.getByRole('status').textContent).toContain('modelGroups.settings.strategyScope');
  expect(next.routes[0].strategy).toBe('rotate');
});
it('reports a rejected save without claiming it was saved or changing the chosen strategy', async () => {
  const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
  set.mockRejectedValueOnce(new Error('unavailable'));
  await openDetail();
  await choose('rotate');
  await waitFor(() => expect(error).toHaveBeenCalledWith('modelGroups.settings.saveFailed'));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'modelGroups.settings.pick' }).textContent).toContain('modelGroups.strategy.order.title');
});
it('does not announce an older receipt as saved while a newer change is queued', async () => {
  let finish!: (next: ModelGroupsConfig) => void;
  let finishSecond!: (next: ModelGroupsConfig) => void;
  set.mockImplementationOnce(() => new Promise<ModelGroupsConfig>(resolve => { finish = resolve; }))
    .mockImplementationOnce(() => new Promise<ModelGroupsConfig>(resolve => { finishSecond = resolve; }));
  await openDetail();
  await choose('rotate');
  await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  await choose('cheapest');
  await act(async () => { finish(set.mock.calls[0][0]); });
  await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { finishSecond(set.mock.calls[1][0]); });
  expect(screen.getByRole('status')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'modelGroups.settings.pick' }).textContent).toContain('modelGroups.strategy.cheapest.title');
});
