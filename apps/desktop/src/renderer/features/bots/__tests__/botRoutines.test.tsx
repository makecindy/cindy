// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
const render = (ui: ReactElement) => testingRender(<MemoryRouter>{ui}</MemoryRouter>);
vi.mock('../BotTaskModelEditor', () => ({ BotTaskModelEditor: ({ onChange }: { onChange: (value: unknown) => void }) => <button onClick={() => onChange({ harness: 'codex', model: 'budget', providerId: 'subscription', effort: 'medium', fastMode: false })}>Choose routine model</button> }));
import type { Routine } from '@cindy/maker-scheduler';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm }) }));
const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
import { BotRoutines } from '../BotRoutines';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSuccess.mockClear();
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
function setup(seed: Partial<Routine> = {}) {
  let records = [{ ...structuredClone(existing), ...seed }];
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
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { routines: api, ghosts: { listControlPointCandidates: vi.fn(async () => [{ pluginId: 'gate', name: 'Gate' }]), onChanged: vi.fn(() => () => {}) } },
  });
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
  expect(toastSuccess).toHaveBeenCalledWith('routines.saved');
  expect(api.runNow).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('button', { name: 'routines.back' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'routines.back' }));
  await screen.findByText('Daily report');
});
it('saves the selected session mode without executing a routine', async () => {
  const api = setup();
  const scrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'routines.sessionMode' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'routines.sessionModeFresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('bot', expect.objectContaining({ sessionMode: 'fresh' }), 'daily'));
  expect(api.runNow).not.toHaveBeenCalled();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
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

// Review of the plugin pre-run check: a routine with both a script and a plugin (set by an Agent) opens on the plugin.
// Saving an unrelated edit must keep the hidden script; choosing the script drops the plugin instead.
it('keeps a script check set alongside a plugin until the check source is changed', async () => {
  const both = { preRunHook: { command: 'node check.mjs' }, preRunPlugin: { pluginId: 'gate', onFailure: 'allow' as const } };
  const api = setup(both);
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Daily report'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('bot', expect.objectContaining({ prompt: 'Edited', ...both }), 'daily'));

  fireEvent.click(screen.getByText('routines.advancedSettings'));
  fireEvent.click(await screen.findByText('scheduler.editor.preRunPlugin.source.script'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), { target: { value: 'Edited again' } });
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('bot', expect.objectContaining({ preRunHook: both.preRunHook, preRunPlugin: null }), 'daily'));
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

it('allows an independent follow-up model while keeping its instructions and triggers fixed', async () => {
  // 宿主内置的「跟进」：引擎只接受 enabled 与模型配置变化（BUILTIN_ROUTINE），界面不给改指令、触发条件或删除的入口。
  const builtin: Routine = {
    ...existing, id: 'builtin-follow-up-bot', name: 'follow-up', prompt: 'host template', builtin: 'follow-up',
  };
  const api = setup();
  api.list.mockResolvedValue([builtin, existing]);
  render(<BotRoutines botId="bot" />);

  const toggle = await screen.findByRole('switch', { name: 'routines.builtinFollowUp.name' });
  expect(screen.queryByText('follow-up')).toBeNull();
  // 内置规则的触发条件很多且来源重复，只写一句固定白话，不逐条列出。
  const row = toggle.parentElement!;
  expect(row.textContent).toContain('routines.builtinFollowUp.hint');
  expect(row.textContent).not.toContain('routines.everyMinutes');
  fireEvent.click(toggle);
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  expect(api.save).toHaveBeenCalledWith(
    'bot',
    { name: 'follow-up', prompt: 'host template', enabled: false, triggers: builtin.triggers },
    'builtin-follow-up-bot',
  );
  expect(api.remove).not.toHaveBeenCalled();
  expect(screen.getByText('Daily report')).toBeTruthy();
  fireEvent.click(screen.getByText('routines.builtinFollowUp.name'));
  expect((screen.getByLabelText('routines.instructions') as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'routines.delete' })).toBeNull();
  fireEvent.click(screen.getByText('Choose routine model'));
  fireEvent.click(screen.getByRole('button', { name: 'routines.save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('bot', expect.objectContaining({
    prompt: 'host template', triggers: builtin.triggers,
    modelOverride: { agentKind: 'codex', model: 'budget', providerId: 'subscription', effort: 'medium', fastMode: false, agentDeviceId: null },
  }), builtin.id));

});

// Production list switches: previously only built-ins could pause without opening
// the editor. Unit tier; the existing save test only covered the editor.
it('pauses from the list, preserves configuration, and keeps the switch on after a failed save', async () => {
  const api = setup();
  render(<BotRoutines botId="bot" />);
  const toggle = await screen.findByRole('switch', { name: 'Daily report' });
  api.save.mockRejectedValueOnce(new Error('disk full'));
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  expect(screen.getByText('routines.paused')).toBeTruthy();
  expect(screen.queryByLabelText('routines.instructions')).toBeNull();
  expect(api.save).toHaveBeenLastCalledWith('bot', {
    name: existing.name, prompt: existing.prompt, enabled: false, triggers: existing.triggers,
  }, existing.id);
  expect(api.runNow).not.toHaveBeenCalled();
});
