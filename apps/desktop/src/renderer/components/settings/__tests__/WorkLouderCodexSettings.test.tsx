// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';

const mocks = vi.hoisted(() => ({
  setSettings: vi.fn(),
  resetSettings: vi.fn(),
  openInputMonitoringSettings: vi.fn(),
  reload: vi.fn(),
  setLayoutPreviewActive: vi.fn(),
  /** Which rule the six task keys follow; drives whether they are clickable. */
  agentSource: 'recent' as string,
  layout: null as ReturnType<typeof createWorkLouderCodexDefaultSettings>['layout'] | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useWorkLouderCodex', () => ({
  useWorkLouderCodex: () => ({
    state: {
      connectionStatus: 'connected',
      connectionReason: null,
      device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE },
      settings: {
        ...createWorkLouderCodexDefaultSettings(),
        lightingBrightness: 70,
        agentSource: mocks.agentSource,
        layout: mocks.layout ?? createWorkLouderCodexDefaultSettings().layout,
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

describe('WorkLouderCodexSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentSource = 'recent';
    mocks.layout = createWorkLouderCodexDefaultSettings().layout;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        workLouderCodex: {
          setLayoutPreviewActive: mocks.setLayoutPreviewActive,
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
        onOpen={onOpen}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.shortcuts.workLouderCodex.openAria' }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(
      screen.getByText('settings.shortcuts.workLouderCodex.connection.status.connected'),
    ).toBeTruthy();
  });

  it('shows the six task keys and writes the settings that remain on the panel', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    // Default source is "recent", so the keys follow the shared rule and are
    // not individually clickable.
    expect(screen.getByRole('img', { name: /AG00/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /AG05/ })).toBeTruthy();
    expect(screen.getByTestId('worklouder-codex-keyboard-layout').parentElement?.className).toContain(
      'justify-center',
    );
    expect(mocks.setLayoutPreviewActive).toHaveBeenCalledWith(true);

    const slider = screen.getByRole('slider', {
      name: 'settings.shortcuts.workLouderCodex.lighting.brightness.aria',
    });
    fireEvent.change(slider, { target: { value: '40' } });
    fireEvent.pointerUp(slider);
    expect(mocks.setSettings).toHaveBeenCalledWith({ lightingBrightness: 40 });

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'settings.shortcuts.workLouderCodex.lighting.autoDim.aria',
      }),
      { target: { value: '10-minutes' } },
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ lightingAutoDim: '10-minutes' });
  });

  it('sets all six task keys at once, since they follow one shared rule', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    // One control for the set, not one per key.
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.source.label',
      }),
      { target: { value: 'pinned' } },
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ agentSource: 'pinned' });

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.singleTap.aria',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ singleTapAgentKeys: true });
  });

  it('only lets a task key be set on its own under "custom"', () => {
    mocks.agentSource = 'custom';
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    // Now each key is its own target, and its editor writes only that slot.
    fireEvent.click(screen.getByRole('button', { name: /AG02/ }));
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'settings.shortcuts.workLouderCodex.actions.choose',
      }),
      { target: { value: 'command:newTask' } },
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      customAgentKeys: [null, null, { type: 'command', commandId: 'newTask' }, null, null, null],
    });
  });

  it('opens the analog stick and encoder editors from the board', () => {
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
    fireEvent.change(up, { target: { value: 'command:toggleSidebar' } });
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

  it('saves a graphical keycap choice and swaps a duplicate assignment', () => {
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
          ACT07: expect.objectContaining({ keycapId: 'FAST' }),
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

  it('does not write microphone-split or assigned-action drafts until Save', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^MIC/ }));
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.microphone.separate.label',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.cancel',
      }),
    );

    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('keeps existing single keys when only the microphone split is saved', () => {
    mocks.layout = {
      ...createWorkLouderCodexDefaultSettings().layout,
      slots: {
        ...createWorkLouderCodexDefaultSettings().layout.slots,
        ACT10: { keycapId: 'FAST', action: { type: 'command', commandId: 'newTask' } },
      },
    };
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^MIC/ }));
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.microphone.separate.label',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        separateMicrophoneKeys: true,
        slots: expect.objectContaining({
          ACT10: expect.objectContaining({
            keycapId: 'FAST',
            action: { type: 'command', commandId: 'newTask' },
          }),
          ACT11: expect.objectContaining({ keycapId: 'EMPT1' }),
          ACT10_ACT11: expect.objectContaining({ keycapId: 'MIC' }),
        }),
      }),
    });
  });

  it('writes a compatible single-width keycap when a merged key is split', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^MIC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'EMPT5' }));
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.microphone.separate.label',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'MIC1' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );

    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        separateMicrophoneKeys: true,
        slots: expect.objectContaining({
          ACT10: expect.objectContaining({ keycapId: 'MIC1', action: null }),
          ACT10_ACT11: expect.objectContaining({ keycapId: 'MIC' }),
        }),
      }),
    });
  });

  it('disables assigned actions for a microphone keycap on a regular command slot', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    fireEvent.click(screen.getByRole('button', { name: 'MIC1' }));

    expect(
      (
        screen.getByRole('combobox', {
          name: 'settings.shortcuts.workLouderCodex.actions.choose',
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.save',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({
      layout: expect.objectContaining({
        slots: expect.objectContaining({
          ACT06: expect.objectContaining({ keycapId: 'MIC1', action: null }),
        }),
      }),
    });
  });
});
