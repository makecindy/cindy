// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotAutomation } from '../../../../shared/botAutomation';
import { DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY } from '../../../../shared/botAutomation';
import type { BotCapabilities, BotProfile } from '../botStore';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <div data-testid="bot-avatar" /> }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  listRuns: vi.fn(),
  onChanged: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  runNow: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  delete: vi.fn(),
  retryDelivery: vi.fn(),
}));

import { BotAutomationSettings } from '../BotAutomationSettings';

function automation(overrides: Partial<BotAutomation> = {}): BotAutomation {
  return {
    id: 'automation-1',
    botId: 'bot-1',
    name: 'Morning digest',
    prompt: 'Summarise yesterday.',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    executionPolicy: DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
    createdWithProfileVersion: 1,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    activeRunCount: 0,
    ...overrides,
  };
}

function capabilities(): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: true,
    permissions: 'trusted',
    sessionControlMode: 'none',
  };
}

function bot(): BotProfile {
  return {
    id: 'bot-1',
    name: 'PR steward',
    channel: 'local',
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    currentVersion: 3,
    skills: [],
    capabilities: capabilities(),
    createdAt: 0,
    sessions: [],
    channels: [],
    projectBindings: [],
    routes: [],
  };
}

function renderSettings(options: { enabled?: boolean; trusted?: boolean } = {}) {
  return render(
    <BotAutomationSettings
      bot={bot()}
      enabled={options.enabled ?? true}
      trusted={options.trusted ?? true}
      onOpenTask={vi.fn()}
    />,
  );
}

function instructionField(): HTMLTextAreaElement {
  return screen.getByLabelText('bots.automations.whatToDo', {
    selector: 'textarea',
  }) as HTMLTextAreaElement;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.list.mockResolvedValue([]);
  api.listRuns.mockResolvedValue([]);
  api.onChanged.mockReturnValue(() => {});
  api.create.mockResolvedValue({ id: 'automation-new' });
  api.update.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { botAutomations: api },
  };
});

afterEach(() => cleanup());

describe('BotAutomationSettings — list first', () => {
  it('renders one row per routine with a plain-language schedule', async () => {
    api.list.mockResolvedValue([
      automation({ id: 'a-1', name: 'Daily digest' }),
      automation({ id: 'a-2', name: 'On demand', manual: true, recurring: false }),
      automation({ id: 'a-3', name: 'Inbox sweep', intervalMs: 30 * 60_000 }),
      automation({ id: 'a-4', name: 'Weekly report', cronExpr: '0 17 * * 5' }),
    ]);
    renderSettings();

    expect(await screen.findByText('Daily digest')).toBeTruthy();
    expect(
      screen.getByText('bots.automations.scheduleSummary.daily:{"time":"09:00"}'),
    ).toBeTruthy();
    expect(screen.getByText('bots.automations.scheduleSummary.manual')).toBeTruthy();
    expect(screen.getByText('bots.automations.scheduleSummary.interval:{"count":30}')).toBeTruthy();
    expect(
      screen.getByText('bots.automations.scheduleSummary.cron:{"expr":"0 17 * * 5"}'),
    ).toBeTruthy();
    // Every row carries its own on/off switch and Run now action.
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: /bots\.automations\.runNow/ })).toHaveLength(4);
    // The engine vocabulary stays out of the list.
    expect(screen.queryByText('bots.automations.executionPolicy')).toBeNull();
    expect(screen.queryByText('bots.automations.noteNamespace')).toBeNull();
  });

  it('keeps the run history and the edit form behind the row', async () => {
    api.list.mockResolvedValue([automation()]);
    renderSettings();

    const row = await screen.findByRole('button', { expanded: false });
    expect(screen.queryByText('bots.automations.runHistory')).toBeNull();
    fireEvent.click(row);

    expect(screen.getByText('bots.automations.runHistory')).toBeTruthy();
    await waitFor(() => expect(api.listRuns).toHaveBeenCalledWith('automation-1', 50));
    expect(screen.getByText('Summarise yesterday.')).toBeTruthy();
    expect(screen.getByText(/bots\.automations\.nextProfileVersion/)).toBeTruthy();
  });

  it('pauses a routine from the row switch', async () => {
    api.list.mockResolvedValue([automation()]);
    renderSettings();

    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.pause).toHaveBeenCalledWith('automation-1'));
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('offers examples in the empty state and loads one into the panel', async () => {
    renderSettings();

    expect(await screen.findByText('bots.automations.empty')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'bots.automations.templates.inboxTriage.name' }),
    );

    expect(instructionField().value).toBe('bots.automations.templates.inboxTriage.prompt');
    const intervalPill = screen.getByRole('radio', { name: 'bots.automations.mode.interval' });
    expect(intervalPill.getAttribute('aria-checked')).toBe('true');
  });
});

describe('BotAutomationSettings — create panel', () => {
  it('creates a runnable routine from the instruction alone', async () => {
    renderSettings();
    await screen.findByText('bots.automations.empty');

    fireEvent.click(screen.getByRole('button', { name: /bots\.automations\.newRoutine/ }));
    // Two questions only: what to do, and when.
    expect(screen.getByText('bots.automations.whatToDo')).toBeTruthy();
    expect(screen.getByText('bots.automations.whenToRun')).toBeTruthy();
    // Engine-level fields are not on the main path.
    expect(screen.queryByText('bots.automations.executionPolicy')).toBeNull();
    expect(screen.queryByText('bots.automations.noteNamespace')).toBeNull();
    expect(screen.queryByText('bots.automations.timezone')).toBeNull();

    const create = screen.getByRole('button', { name: 'bots.automations.create' });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(instructionField(), { target: { value: 'Summarise yesterday.' } });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]![0]).toMatchObject({
      botId: 'bot-1',
      name: 'Summarise yesterday.',
      prompt: 'Summarise yesterday.',
      cronExpr: '0 9 * * *',
      recurring: true,
      manual: false,
      intervalMs: undefined,
      projectBindingId: null,
      targetRouteId: null,
      durableNoteNamespace: 'summarise-yesterday',
      executionPolicy: DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
    });
    expect(typeof api.create.mock.calls[0]![0].timezone).toBe('string');
    expect(api.create.mock.calls[0]![0].timezone.length).toBeGreaterThan(0);
  });

  it('keeps Advanced collapsed by default and unchanged defaults after opening it', async () => {
    renderSettings();
    await screen.findByText('bots.automations.empty');
    fireEvent.click(screen.getByRole('button', { name: /bots\.automations\.newRoutine/ }));
    fireEvent.change(instructionField(), { target: { value: 'Summarise yesterday.' } });

    const advanced = screen.getByRole('button', { name: /bots\.automations\.advanced/ });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('bots.automations.executionPolicy')).toBeTruthy();
    expect(screen.getByText('bots.automations.project')).toBeTruthy();
    // Collapsing again must not drop or alter what the defaults submit.
    fireEvent.click(advanced);
    expect(screen.queryByText('bots.automations.executionPolicy')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.automations.create' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]![0]).toMatchObject({
      cronExpr: '0 9 * * *',
      durableNoteNamespace: 'summarise-yesterday',
      executionPolicy: DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY,
    });
  });

  it('switches the cadence from the segmented control', async () => {
    renderSettings();
    await screen.findByText('bots.automations.empty');
    fireEvent.click(screen.getByRole('button', { name: /bots\.automations\.newRoutine/ }));
    fireEvent.change(instructionField(), { target: { value: 'Sweep the inbox' } });

    fireEvent.click(screen.getByRole('radio', { name: 'bots.automations.mode.interval' }));
    fireEvent.change(
      screen.getByLabelText('bots.automations.intervalMinutes', { selector: 'input' }),
      { target: { value: '30' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'bots.automations.create' }));

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]![0]).toMatchObject({
      intervalMs: 30 * 60_000,
      recurring: true,
      manual: false,
    });
  });

  it('only exposes the cron field on the custom cadence', async () => {
    renderSettings();
    await screen.findByText('bots.automations.empty');
    fireEvent.click(screen.getByRole('button', { name: /bots\.automations\.newRoutine/ }));

    expect(screen.queryByText('bots.automations.cronExpr')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'bots.automations.mode.cron' }));
    expect(screen.getByText('bots.automations.cronExpr')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'bots.automations.mode.manual' }));
    expect(screen.queryByText('bots.automations.cronExpr')).toBeNull();
    expect(screen.getByText('bots.automations.manualHint')).toBeTruthy();
  });

  it('hides the create affordance until Automation is enabled and trusted', async () => {
    renderSettings({ enabled: false });
    expect(await screen.findByText('bots.automations.enableFirst')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bots\.automations\.newRoutine/ })).toBeNull();
    cleanup();

    renderSettings({ trusted: false });
    expect(await screen.findByText('bots.automations.trustedRequired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bots\.automations\.newRoutine/ })).toBeNull();
  });
});
