// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { TaskRuntimePluginsDialog } from '../TaskRuntimePluginsDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const runtimePlugins = vi.fn();
const candidates = vi.fn();
const dismiss = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  runtimePlugins.mockResolvedValue({});
  candidates.mockImplementation(async (point: string) => [{ pluginId: point, name: point }]);
  Object.assign(window, { electronAPI: { ghosts: { runtimePlugins,
    listControlPointCandidates: candidates,
  } } });
});
afterEach(cleanup);
const session = { id: 'task', agentKind: 'pi', status: 'active' } as Session;

// Unit, production dialog: empty controls must not turn into five placeholder
// sections. Existing coverage gave every control a candidate and missed this case.
it('does not render empty runtime control groups', async () => {
  candidates.mockImplementation(async (point: string) => point === 'will-compose-context'
    ? [{ pluginId: 'reference', name: 'Reference provider' }] : []);
  render(<TaskRuntimePluginsDialog session={session} onDismiss={dismiss} />);
  await screen.findByRole('checkbox', { name: 'Reference provider' });
  expect(screen.getAllByRole('group')).toHaveLength(1);
});

// Unit, real dialog/checkbox/save path: installation does not opt tasks in.
// The saved IPC payload must contain only explicit choices, with no extra calls.
it('starts unselected and saves only explicit task choices', async () => {
  render(<TaskRuntimePluginsDialog session={session} onDismiss={dismiss} />);
  const router = await screen.findByRole('checkbox', { name: 'will-start-turn' });
  const editor = screen.getByRole('checkbox', { name: 'will-model-request' });
  expect((router as HTMLInputElement).checked).toBe(false);
  expect((editor as HTMLInputElement).checked).toBe(false);
  fireEvent.click(router);
  fireEvent.click(screen.getByRole('button', { name: 'runtimePlugins.save' }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
  expect(runtimePlugins.mock.calls).toEqual([['task'], ['task', {
    'will-start-turn': [{ pluginId: 'will-start-turn', onFailure: 'block' }],
  }]]);
});

it('does not save a stale owner selection and disables unsupported request control', async () => {
  render(<TaskRuntimePluginsDialog session={{ ...session, agentKind: 'codex' }} onDismiss={dismiss} />);
  const editor = await screen.findByRole('checkbox', { name: 'will-model-request' });
  expect((editor as HTMLInputElement).disabled).toBe(true);
  setDataOwnerGeneration('other-owner');
  fireEvent.click(screen.getByRole('button', { name: 'runtimePlugins.save' }));
  expect(runtimePlugins).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
});
