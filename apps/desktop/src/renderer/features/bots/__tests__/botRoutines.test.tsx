// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Routine } from '@cindy/maker-scheduler';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm }) }));
import { BotRoutines } from '../BotRoutines';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('saves the visible edited instructions before running, and preserves every trigger', async () => {
  const routine: Routine = {
    id: 'routine',
    botId: 'bot',
    name: 'Review',
    prompt: 'Old instructions',
    enabled: true,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    triggers: [
      { id: 'timer', kind: 'interval', intervalMs: 3600000 },
      { id: 'pr', kind: 'event', sourceId: 'plugin:git', eventType: 'pr', filters: [] },
    ],
  };
  const calls: string[] = [];
  const save = vi.fn(async (_bot, input) => {
    calls.push('save');
    return { ...routine, ...input };
  });
  const runNow = vi.fn(async () => {
    calls.push('run');
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      routines: {
        list: vi.fn(async () => [routine]),
        sources: vi.fn(async () => []),
        history: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
        save,
        runNow,
      },
    },
  });
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Review'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), {
    target: { value: 'Review the new PR only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'routines.runNow' }));
  await waitFor(() => expect(runNow).toHaveBeenCalledWith('bot', 'routine'));
  expect(calls).toEqual(['save', 'run']);
  expect(save).toHaveBeenCalledWith(
    'bot',
    expect.objectContaining({ prompt: 'Review the new PR only', triggers: routine.triggers }),
    'routine',
  );
});

const existing: Routine = {
  id: 'daily', botId: 'bot', name: 'Daily report', prompt: 'Summarize today', enabled: true,
  revision: 1, createdAt: 1, updatedAt: 1,
  triggers: [{ id: 'timer', kind: 'interval', intervalMs: 3_600_000 }],
};
function setup() {
  let records = [structuredClone(existing)];
  const api = {
    list: vi.fn(async () => records), sources: vi.fn(async () => []),
    history: vi.fn(async () => []), onChanged: vi.fn(() => () => {}),
    save: vi.fn(async (_bot: string, value: object) => {
      const saved = { ...existing, ...value };
      records = [saved];
      return saved;
    }),
    runNow: vi.fn(async () => {}), remove: vi.fn(async () => { records = []; }),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { routines: api } });
  return api;
}
it('retries a failed initial load instead of showing a false empty state', async () => {
  const api = setup();
  api.list.mockRejectedValueOnce(new Error('offline'));
  render(<BotRoutines botId="bot" />);
  await screen.findByRole('alert');
  expect(screen.queryByText('routines.empty')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.retry' }));
  await screen.findByText('Daily report');
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('does not run when saving fails, keeps edited text, and allows retry', async () => {
  const api = setup();
  api.save.mockRejectedValueOnce(new Error('disk full'));
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), { target: { value: 'New instructions' } });
  fireEvent.click(screen.getByRole('button', { name: 'routines.runNow' }));
  await screen.findByRole('alert');
  expect(api.runNow).not.toHaveBeenCalled();
  expect((screen.getByLabelText('routines.instructions') as HTMLTextAreaElement).value).toBe('New instructions');
  fireEvent.click(screen.getByRole('button', { name: 'routines.runNow' }));
  await waitFor(() => expect(api.runNow).toHaveBeenCalledOnce());
  expect(api.save).toHaveBeenLastCalledWith('bot', expect.objectContaining({ prompt: 'New instructions' }), 'daily');
});
it('blocks duplicate execution and leaving while a save is pending', async () => {
  const api = setup();
  let finish!: (value: Routine) => void;
  api.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const guard = { current: null as (() => Promise<boolean>) | null };
  render(<BotRoutines botId="bot" beforeLeaveRef={guard} />);
  fireEvent.click(await screen.findByText('Daily report'));
  const run = screen.getByRole('button', { name: 'routines.runNow' });
  fireEvent.click(run); fireEvent.click(run);
  expect(api.save).toHaveBeenCalledOnce();
  expect(await guard.current!()).toBe(false);
  expect((screen.getByRole('button', { name: 'routines.back' }) as HTMLButtonElement).disabled).toBe(true);
  finish(existing);
  await waitFor(() => expect(api.runNow).toHaveBeenCalledOnce());
});
it('saves enabled state and does not run a routine just by saving', async () => {
  const api = setup();
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('bot', expect.objectContaining({ enabled: false }), 'daily'));
  expect(api.runNow).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('button', { name: 'routines.back' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'routines.back' }));
  await screen.findByText('Daily report');
});
it('requires confirmation for deletion, then refreshes the list', async () => {
  const api = setup();
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.click(screen.getByRole('button', { name: 'routines.delete' }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'routines.keep' }));
  expect(screen.queryByText('routines.deleteConfirm')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'routines.delete' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'routines.delete' })[1]!);
  await screen.findByText('routines.empty');
  expect(api.remove).toHaveBeenCalledWith('bot', 'daily');
});

it('keeps unsaved instructions when leaving is cancelled and clears the registered guard on unmount', async () => {
  setup();
  const guard = { current: null as (() => Promise<boolean>) | null };
  const view = render(<BotRoutines botId="bot" beforeLeaveRef={guard} />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), { target: { value: 'Unsaved' } });
  confirm.mockResolvedValueOnce(false);
  expect(await guard.current!()).toBe(false);
  expect((screen.getByLabelText('routines.instructions') as HTMLTextAreaElement).value).toBe('Unsaved');
  confirm.mockResolvedValueOnce(true);
  expect(await guard.current!()).toBe(true);
  view.unmount();
  expect(guard.current).toBeNull();
});
