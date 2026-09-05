// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';

const mocks = vi.hoisted(() => ({
  setSettings: vi.fn(),
  resetSettings: vi.fn(),
  openInputMonitoringSettings: vi.fn(),
  reload: vi.fn(),
  setGuardEnabled: vi.fn(),
  recoverGuard: vi.fn(),
  guardRestartRequired: false,
  guardStatus: 'disabled' as 'disabled' | 'protecting' | 'intercepted' | 'recovery-required',
  setLayoutPreviewActive: vi.fn(),
  previewListeners: [] as Array<
    (input: {
      part: string;
      pressed: boolean;
      turn?: number;
      angle?: number;
      distance?: number;
    }) => void
  >,
  /** Which rule the six task keys follow; drives whether they are clickable. */
  agentSource: 'sidebar' as string,
  layout: null as ReturnType<typeof createWorkLouderCodexDefaultSettings>['layout'] | null,
  deviceEnabled: true,
  connectionStatus: 'connected' as 'connected' | 'error',
  connectionReason: null as 'device-in-use' | 'permission-required' | 'connection-failed' | null,
  deviceType: 'codex-micro' as 'codex-micro' | 'creator-micro-2',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useCodexMicroGuard', () => ({
  useCodexMicroGuard: () => ({
    state: {
      supported: true,
      enabled: mocks.guardStatus === 'protecting' || mocks.guardStatus === 'intercepted',
      status: mocks.guardStatus,
      restartRequired: mocks.guardRestartRequired,
    },
    loading: false,
    saving: false,
    error: false,
    setEnabled: mocks.setGuardEnabled,
    recover: mocks.recoverGuard,
    reload: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWorkLouderCodex', () => ({
  useWorkLouderCodex: () => ({
    state: {
      connectionStatus: mocks.connectionStatus,
      connectionReason: mocks.connectionReason,
      devicePresent: true,
      device: {
        ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
        deviceType: mocks.deviceType,
        isUsbConnection: true,
      },
      settings: {
        ...createWorkLouderCodexDefaultSettings(mocks.deviceType),
        deviceEnabled: mocks.deviceEnabled,
        lightingBrightness: 70,
        agentSource: mocks.agentSource,
        layout: mocks.layout ?? createWorkLouderCodexDefaultSettings(mocks.deviceType).layout,
      },
      agentSlots: Array.from({ length: 6 }, (_, slot) => ({
        slot,
        sessionId: null,
        title: null,
        action: null,
      })),
      taskOptions: [],
      agentSlotCount: 6,
    },
    loading: false,
    saving: false,
    error: null,
    setSettings: mocks.setSettings,
    resetSettings: mocks.resetSettings,
    openInputMonitoringSettings: mocks.openInputMonitoringSettings,
    reload: mocks.reload,
  }),
}));

vi.mock('@/features/skillhub/hooks/useSkillhub', () => ({
  useSkillhub: () => ({
    skills: [],
    bootstrapped: true,
    refresh: vi.fn(),
  }),
}));

import { WorkLouderCodexEntry, WorkLouderCodexSettings } from '../WorkLouderCodexSettings';

async function chooseSelectOption(
  trigger: string | HTMLElement,
  optionName: string,
): Promise<void> {
  const combobox =
    typeof trigger === 'string' ? screen.getByRole('combobox', { name: trigger }) : trigger;
  fireEvent.keyDown(combobox, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

describe('WorkLouderCodexSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mocks.agentSource = 'sidebar';
    mocks.layout = createWorkLouderCodexDefaultSettings().layout;
    mocks.guardStatus = 'disabled';
    mocks.guardRestartRequired = false;
    mocks.deviceEnabled = true;
    mocks.connectionStatus = 'connected';
    mocks.connectionReason = null;
    mocks.deviceType = 'codex-micro';
    mocks.previewListeners = [];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        workLouderCodex: {
          setLayoutPreviewActive: mocks.setLayoutPreviewActive,
          onPreviewInput: (
            callback: (input: {
              part: string;
              pressed: boolean;
              turn?: number;
              angle?: number;
              distance?: number;
            }) => void,
          ) => {
            mocks.previewListeners.push(callback);
            return () => {
              mocks.previewListeners = mocks.previewListeners.filter((item) => item !== callback);
            };
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('renders a keyboard-shortcuts entry with live connection status', () => {
    const onOpen = vi.fn();
    render(
      <WorkLouderCodexEntry
        state={{
          connectionStatus: 'connected',
          connectionReason: null,
          devicePresent: true,
          device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
          settings: { ...createWorkLouderCodexDefaultSettings(), deviceEnabled: true },
          agentSlots: Array.from({ length: 6 }, (_, slot) => ({
            slot,
            sessionId: null,
            title: null,
            action: null,
          })),
          taskOptions: [],
          agentSlotCount: 6,
        }}
        loading={false}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByText('settings.shortcuts.workLouderCodex.beta')).toBeNull();
    expect(
      screen.getByText('settings.shortcuts.workLouderCodex.connection.status.connected'),
    ).toBeTruthy();
  });

  it('shows off on the shortcuts entry when the keyboard is present but this instance is off', () => {
    render(
      <WorkLouderCodexEntry
        state={{
          connectionStatus: 'connecting',
          connectionReason: null,
          devicePresent: true,
          device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
          settings: createWorkLouderCodexDefaultSettings(),
          agentSlots: Array.from({ length: 6 }, (_, slot) => ({
            slot,
            sessionId: null,
            title: null,
            action: null,
          })),
          taskOptions: [],
          agentSlotCount: 6,
        }}
        loading={false}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByText('settings.shortcuts.workLouderCodex.connection.status.disabled'),
    ).toBeTruthy();
    expect(
      screen.queryByText('settings.shortcuts.workLouderCodex.connection.status.connected'),
    ).toBeNull();
    expect(
      screen.queryByText('settings.shortcuts.workLouderCodex.connection.status.connecting'),
    ).toBeNull();
  });

  it('shows the six task keys and writes the settings that remain on the panel', async () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    expect(screen.getByRole('button', { name: /AG00/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AG05/ })).toBeTruthy();
    expect(
      screen.queryByText('settings.shortcuts.workLouderCodex.device.inputMonitoring.label'),
    ).toBeNull();
    expect(screen.getByText('Codex Micro')).toBeTruthy();
    expect(screen.getByText('USB')).toBeTruthy();
    expect(
      screen.getByTestId('worklouder-codex-keyboard-layout').parentElement?.className,
    ).toContain('justify-center');
    expect(mocks.setLayoutPreviewActive).toHaveBeenCalledWith(true, 'codex-micro');

    const slider = screen.getByRole('slider', {
      name: 'settings.shortcuts.workLouderCodex.lighting.brightness.aria',
    });
    fireEvent.change(slider, { target: { value: '40' } });
    fireEvent.pointerUp(slider);
    expect(mocks.setSettings).toHaveBeenCalledWith({ lightingBrightness: 40 });

    await chooseSelectOption(
      'settings.shortcuts.workLouderCodex.lighting.autoDim.aria',
      'settings.shortcuts.workLouderCodex.lighting.autoDim.options.10-minutes',
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ lightingAutoDim: '10-minutes' });
  });

  it.each(['codex-micro', 'creator-micro-2'] as const)(
    'shares Codex protection and recovery for %s',
    (model) => {
      mocks.deviceType = model;
      mocks.layout = createWorkLouderCodexDefaultSettings(model).layout;
      const { unmount } = render(<WorkLouderCodexSettings model={model} onBack={vi.fn()} />);

      fireEvent.click(
        screen.getByRole('switch', {
          name: 'settings.shortcuts.workLouderCodex.codexGuard.aria',
        }),
      );
      expect(mocks.setGuardEnabled).toHaveBeenCalledWith(true);
      expect(
        screen.queryByText('settings.shortcuts.workLouderCodex.codexGuard.status.disabled'),
      ).toBeNull();
      unmount();

      mocks.guardStatus = 'recovery-required';
      render(<WorkLouderCodexSettings model={model} onBack={vi.fn()} />);
      fireEvent.click(
        screen.getByRole('button', {
          name: 'settings.shortcuts.workLouderCodex.codexGuard.recover',
        }),
      );
      expect(mocks.recoverGuard).toHaveBeenCalledOnce();
    },
  );

  it.each(['codex-micro', 'creator-micro-2'] as const)(
    'places compatibility last and only shows a needed restart for %s',
    (model) => {
      mocks.deviceType = model;
      mocks.layout = createWorkLouderCodexDefaultSettings(model).layout;
      mocks.guardStatus = 'protecting';
      const { rerender, container } = render(
        <WorkLouderCodexSettings model={model} onBack={vi.fn()} />,
      );
      const prefix = 'settings.shortcuts.workLouderCodex.codexGuard';
      expect(container.firstElementChild?.lastElementChild?.textContent).toContain(
        `${prefix}.label`,
      );
      expect(screen.queryByText(`${prefix}.restartRequired`)).toBeNull();
      expect(screen.queryByText(`${prefix}.descriptions.protecting`)).toBeNull();

      mocks.guardRestartRequired = true;
      rerender(<WorkLouderCodexSettings model={model} onBack={vi.fn()} />);
      const hint = screen.getByText(`${prefix}.restartRequired`);
      const toggle = screen.getByRole('switch', { name: `${prefix}.aria` });
      expect(hint.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      mocks.guardRestartRequired = false;
      rerender(<WorkLouderCodexSettings model={model} onBack={vi.fn()} />);
      expect(screen.queryByText(`${prefix}.restartRequired`)).toBeNull();
      mocks.guardRestartRequired = true;
      mocks.guardStatus = 'disabled';
      rerender(<WorkLouderCodexSettings model={model} onBack={vi.fn()} />);
      expect(screen.queryByText(`${prefix}.restartRequired`)).toBeNull();
    },
  );

  it('sets all six task keys at once, since they follow one shared rule', async () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    // One control for the set, not one per key.
    await chooseSelectOption(
      'settings.shortcuts.workLouderCodex.agentKeys.source.label',
      'settings.shortcuts.workLouderCodex.agentKeys.source.options.last-sent',
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ agentSource: 'last-sent' });

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.connection.toggle.aria',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ deviceEnabled: false });

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.singleTap.aria',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ singleTapAgentKeys: false });
  });

  it('only lets a task key be set on its own under "custom"', async () => {
    mocks.agentSource = 'custom';
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    // Now each key is its own target, and its editor writes only that slot.
    fireEvent.click(screen.getByRole('button', { name: /AG02/ }));
    await chooseSelectOption('settings.shortcuts.workLouderCodex.actions.choose', 'New Task');

    expect(mocks.setSettings).toHaveBeenCalledWith({
      customAgentKeys: [null, null, { type: 'command', commandId: 'newTask' }, null, null, null],
    });
  });

  it('opens the analog stick and encoder editors from the board', async () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: /settings\.shortcuts\.workLouderCodex\.layout\.keyboard\.analogStick/,
      }),
    );
    // One select per direction; the first is "up".
    const [up] = screen.getAllByRole('combobox', {
      name: 'settings.shortcuts.workLouderCodex.actions.choose',
    });
    await chooseSelectOption(up, 'Toggle Sidebar');
    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        analogStick: expect.objectContaining({
          up: { type: 'command', commandId: 'toggleSidebar' },
        }),
      }),
    });
  });

  it('restores all device settings to their defaults', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.reset' }));

    expect(mocks.resetSettings).toHaveBeenCalledOnce();
  });

  it('restores the keyboard layout from the layout section header', () => {
    const defaults = createWorkLouderCodexDefaultSettings();
    mocks.layout = {
      ...defaults.layout,
      slots: {
        ...defaults.layout.slots,
        ACT06: { keycapId: 'APPR', action: null },
      },
    };
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    expect(screen.queryByText('settings.shortcuts.workLouderCodex.layout.reset.title')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.reset.button',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        slots: expect.objectContaining({
          ACT06: expect.objectContaining({ keycapId: 'FAST' }),
        }),
      }),
    });
  });

  it('allows the same keycap on more than one key', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(screen.getByRole('button', { name: 'APPR' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        slots: expect.objectContaining({
          ACT06: expect.objectContaining({ keycapId: 'APPR' }),
          ACT07: expect.objectContaining({ keycapId: 'APPR' }),
        }),
      }),
    });
  });

  it('cancels graphical keycap editing without writing settings', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(screen.getByRole('button', { name: 'GIT' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.cancel',
      }),
    );

    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('splits a 2U key immediately from the editor', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^MIC/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.merge.split',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        separateMicrophoneKeys: true,
        merges: [],
      }),
    });
  });

  it('merges a 1U key with its right neighbor', () => {
    const defaults = createWorkLouderCodexDefaultSettings();
    mocks.layout = { ...defaults.layout, separateMicrophoneKeys: true, merges: [] };
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.merge.right',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        merges: [{ origin: 'ACT06', cover: 'ACT07' }],
      }),
    });
  });

  it('keeps the previous action when merging a 1U key', () => {
    const defaults = createWorkLouderCodexDefaultSettings();
    mocks.layout = {
      ...defaults.layout,
      separateMicrophoneKeys: true,
      merges: [],
      slots: {
        ...defaults.layout.slots,
        ACT06: { keycapId: 'FAST', action: { type: 'command', commandId: 'forkTask' } },
      },
    };
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.merge.right',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        merges: [{ origin: 'ACT06', cover: 'ACT07' }],
      }),
    });
    expect(mocks.setSettings.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        layout: expect.objectContaining({
          slots: expect.objectContaining({
            ACT06: expect.objectContaining({
              action: { type: 'command', commandId: 'forkTask' },
            }),
          }),
        }),
      }),
    );
  });

  it('lets a microphone keycap keep a rebound action, same as any other key', async () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(screen.getByRole('button', { name: 'MIC' }));
    const actionSelect = screen.getByRole('combobox', {
      name: 'settings.shortcuts.workLouderCodex.actions.choose',
    }) as HTMLSelectElement;
    expect(actionSelect.disabled).toBe(false);
    await chooseSelectOption('settings.shortcuts.workLouderCodex.actions.choose', 'Fork Task');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        slots: expect.objectContaining({
          ACT06: expect.objectContaining({
            keycapId: 'MIC',
            action: { type: 'command', commandId: 'forkTask' },
          }),
        }),
      }),
    });
  });

  it('draws encoder turns and stick travel from live preview input', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    act(() => {
      for (const listener of mocks.previewListeners) {
        listener({ part: 'encoder', pressed: false, turn: 1 });
        listener({ part: 'encoder', pressed: false, turn: 1 });
        listener({ part: 'analog', pressed: true, angle: 0, distance: 1 });
      }
    });

    expect(
      screen
        .getByRole('button', {
          name: /settings\.shortcuts\.workLouderCodex\.layout\.keyboard\.encoder/,
        })
        .querySelector('[data-encoder-turns]')
        ?.getAttribute('data-encoder-turns'),
    ).toBe('2');
    expect(screen.getByTestId('worklouder-codex-stick-cap').getAttribute('style')).toContain(
      'translate(10px, 0px)',
    );
  });

  it('tells Creator Micro 2 users that enabling rewrites the current layer', () => {
    mocks.deviceType = 'creator-micro-2';
    mocks.deviceEnabled = false;
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    expect(
      screen.getByText(
        'settings.shortcuts.workLouderCodex.models.creatorMicro2.connection.descriptions.disabled',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText('settings.shortcuts.workLouderCodex.connection.descriptions.disabled'),
    ).toBeNull();
  });

  it('shows occupancy contention instead of Input Monitoring for Creator Micro 2', () => {
    mocks.deviceType = 'creator-micro-2';
    mocks.connectionStatus = 'error';
    mocks.connectionReason = 'device-in-use';
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    expect(
      screen.getByText(
        'settings.shortcuts.workLouderCodex.models.creatorMicro2.connection.descriptions.device-in-use',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'settings.shortcuts.workLouderCodex.connection.descriptions.permission-required',
      ),
    ).toBeNull();
    expect(
      screen.queryByText('settings.shortcuts.workLouderCodex.device.inputMonitoring.label'),
    ).toBeNull();
  });

  it('promotes a Codex command key into the task-key set', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.role.task',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({
          taskKeys: expect.arrayContaining(['ACT06']),
        }),
      }),
    );
    expect(
      screen.getByRole('radio', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.role.task',
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.done',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledTimes(2);
  });

  it('promotes a Creator command key into the task-key set', () => {
    mocks.deviceType = 'creator-micro-2';
    mocks.layout = createWorkLouderCodexDefaultSettings('creator-micro-2').layout;
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Toggle Fast Mode/ }));
    expect(
      screen.getByRole('radio', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.role.action',
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.role.task',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({
          taskKeys: expect.arrayContaining(['ACT06']),
        }),
      }),
    );
    expect(
      screen.getByRole('radio', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.role.task',
      }),
    ).toBeTruthy();
  });

  it('describes Creator task order without the six-key AG limit', () => {
    mocks.deviceType = 'creator-micro-2';
    mocks.layout = createWorkLouderCodexDefaultSettings('creator-micro-2').layout;
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    expect(
      screen.getByText('settings.shortcuts.workLouderCodex.agentKeys.source.descriptions.sidebar'),
    ).toBeTruthy();
  });

  it('explains the six-light firmware limit when more than six task keys are set', () => {
    mocks.deviceType = 'creator-micro-2';
    const layout = createWorkLouderCodexDefaultSettings('creator-micro-2').layout;
    layout.taskKeys = [...WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS];
    mocks.layout = layout;
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    expect(
      screen.getByText('settings.shortcuts.workLouderCodex.agentKeys.lightingLimit'),
    ).toBeTruthy();
  });

  it('offers 2U merge on Creator action keys', () => {
    mocks.deviceType = 'creator-micro-2';
    mocks.layout = createWorkLouderCodexDefaultSettings('creator-micro-2').layout;
    render(<WorkLouderCodexSettings model="creator-micro-2" onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: /settings\.shortcuts\.workLouderCodex\.actions\.voice/,
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.merge.right',
      }),
    ).toBeTruthy();
  });

  it('writes a custom Codex task to the remapped slot after AG00 is demoted', async () => {
    mocks.agentSource = 'custom';
    const layout = createWorkLouderCodexDefaultSettings().layout;
    layout.taskKeys = ['AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'ACT07'];
    mocks.layout = layout;
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /AG01/ }));
    await chooseSelectOption('settings.shortcuts.workLouderCodex.actions.choose', 'New Task');
    expect(mocks.setSettings).toHaveBeenCalledWith({
      customAgentKeys: [{ type: 'command', commandId: 'newTask' }, null, null, null, null, null],
    });
  });

  it('does not offer a custom assignment for unlit extra task keys', () => {
    mocks.agentSource = 'custom';
    const layout = createWorkLouderCodexDefaultSettings().layout;
    layout.taskKeys = ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'ACT07'];
    mocks.layout = layout;
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /ACT07/ }));
    expect(screen.getByText('settings.shortcuts.workLouderCodex.agentKeys.unlitKey')).toBeTruthy();
    expect(
      screen.queryByRole('combobox', {
        name: 'settings.shortcuts.workLouderCodex.actions.choose',
      }),
    ).toBeNull();
  });
});
