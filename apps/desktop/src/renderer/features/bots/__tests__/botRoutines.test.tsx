// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole('switch', { name: 'routines.enabled' }));
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

it('saves advanced quiet and pre-run settings without executing a check on open', async () => {
  const api = setup();
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  expect(api.save).not.toHaveBeenCalled();
  expect(api.runNow).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('routines.advancedSettings'));
  expect(screen.getByRole('switch', { name: 'routines.quiet' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('switch', { name: 'routines.quiet' }));
  fireEvent.change(screen.getByLabelText('routines.checkCommand'), { target: { value: 'node check.mjs' } });
  fireEvent.change(screen.getByLabelText('routines.timeoutMs'), { target: { value: '3000' } });
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('bot', expect.objectContaining({ silentWhenIdle: false, preRunHook: { command: 'node check.mjs', timeoutMs: 3000 } }), 'daily'));
  expect(api.runNow).not.toHaveBeenCalled();
});

it('starts a new unclassified routine with delivery enabled', async () => {
  setup();
  render(<BotRoutines botId="bot" />);
  fireEvent.click(screen.getByRole('button', { name: 'routines.add' }));
  fireEvent.click(screen.getByText('routines.advancedSettings'));
  expect(screen.getByRole('switch', { name: 'routines.quiet' }).getAttribute('aria-checked')).toBe('false');
});

it('lets number and time fields be cleared and retyped without saving invalid schedules', async () => {
  const api = setup();
  const scheduled: Routine = {
    ...existing,
    triggers: [
      { id: 'timer', kind: 'interval', intervalMs: 3_600_000 },
      { id: 'monthly', kind: 'cron', expression: '0 9 15 * *', timezone: 'UTC' },
    ],
  };
  api.list.mockResolvedValue([scheduled]);
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  for (const details of document.querySelectorAll('details')) details.open = true;
  const minutes = screen.getByLabelText('routines.minutes') as HTMLInputElement;
  expect(minutes.getAttribute('aria-invalid')).toBeNull();
  fireEvent.change(minutes, { target: { value: '' } });
  fireEvent.blur(minutes);
  expect(minutes.value).toBe('');
  expect(minutes.getAttribute('aria-invalid')).toBe('true');
  const day = screen.getByLabelText('routines.day') as HTMLInputElement;
  fireEvent.change(day, { target: { value: '40' } });
  expect(day.getAttribute('aria-invalid')).toBe('true');
  // Saving would silently keep the old numbers; point at the first invalid field instead.
  (minutes.closest('details') as HTMLDetailsElement).open = false;
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  expect(api.save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(minutes);
  expect((minutes.closest('details') as HTMLDetailsElement).open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'routines.runNow' }));
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(minutes, { target: { value: '5' } });
  fireEvent.change(day, { target: { value: '20' } });
  expect(day.getAttribute('aria-invalid')).toBeNull();
  const time = screen.getByLabelText('routines.time') as HTMLInputElement;
  fireEvent.change(time, { target: { value: '' } });
  expect(screen.getByLabelText('routines.day')).toBeTruthy();
  fireEvent.change(time, { target: { value: '10:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalled());
  expect(api.save.mock.calls[0]?.[1]).toMatchObject({
    triggers: [
      { id: 'timer', kind: 'interval', intervalMs: 300_000 },
      { id: 'monthly', kind: 'cron', expression: '30 10 20 * *', timezone: 'UTC' },
    ],
  });
});

it('hands the editor back step to the host back button and focuses a new routine name', async () => {
  setup();
  const back = { current: null as (() => Promise<boolean>) | null };
  render(<BotRoutines embedded botId="bot" backRef={back} />);
  fireEvent.click(await screen.findByText('Daily report'));
  expect(screen.queryByRole('button', { name: 'routines.back' })).toBeNull();
  let handled = false;
  await act(async () => {
    handled = await back.current!();
  });
  expect(handled).toBe(true);
  await screen.findByText('Daily report');
  expect(await back.current!()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'routines.add' }));
  expect(document.activeElement).toBe(screen.getByLabelText('routines.name'));
});
