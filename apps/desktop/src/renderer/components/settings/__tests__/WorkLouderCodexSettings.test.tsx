// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';

const mocks = vi.hoisted(() => ({
  setSettings: vi.fn(),
  resetSettings: vi.fn(),
  openInputMonitoringSettings: vi.fn(),
  reload: vi.fn(),
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

  it('shows the six recent-task slots and writes each supported setting', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    expect(screen.getByRole('img', { name: /AG00/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /AG05/ })).toBeTruthy();

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

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'settings.shortcuts.workLouderCodex.agentKeys.singleTap.aria',
      }),
    );
    expect(mocks.setSettings).toHaveBeenCalledWith({ singleTapAgentKeys: true });
  });

  it('restores all device settings to their defaults', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.reset' }));

    expect(mocks.resetSettings).toHaveBeenCalledOnce();
  });

  it('saves a graphical keycap choice and swaps a duplicate assignment', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'ACT06 FAST' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'ACT06 FAST' }));
    fireEvent.click(screen.getByRole('button', { name: 'GIT' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.shortcuts.workLouderCodex.layout.editor.cancel',
      }),
    );

    expect(mocks.setSettings).not.toHaveBeenCalled();
  });
});
