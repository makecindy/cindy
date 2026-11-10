// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { TaskRuntimePluginsDialog } from '../TaskRuntimePluginsDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const runtimePlugins = vi.fn();
const dismiss = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  runtimePlugins.mockResolvedValue({});
  Object.assign(window, { electronAPI: { ghosts: { runtimePlugins,
    listControlPointCandidates: async (point: string) => [{ pluginId: point, name: point }],
  } } });
});
afterEach(cleanup);
const session = { id: 'task', agentKind: 'pi', status: 'active' } as Session;

// Unit, real dialog/checkbox/save path: installation does not opt tasks in.
// The saved IPC payload must contain only explicit choices, with no extra calls.
it('starts unselected and saves only explicit task choices', async () => {
  render(<TaskRuntimePluginsDialog session={session} onDismiss={dismiss} />);
  const router = await screen.findByRole('checkbox', { name: 'will-start-turn' });
  const editor = screen.getByRole('checkbox', { name: 'will-model-request' });
  expect((router as HTMLInputElement).checked).toBe(false);
  expect((editor as HTMLInputElement).checked).toBe(false);
  fireEvent.click(router);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  expect(runtimePlugins).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
});
