// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSettings: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useWorkLouderCodex', () => ({
  useWorkLouderCodex: () => ({
    state: {
      connectionStatus: 'connected',
      settings: {
        lightingBrightness: 70,
        lightingAutoDim: '3-minutes',
        singleTapAgentKeys: true,
      },
      agentSource: 'recent',
      agentSlotCount: 6,
    },
    loading: false,
    saving: false,
    error: null,
    setSettings: mocks.setSettings,
    reload: mocks.reload,
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
          settings: {
            lightingBrightness: 100,
            lightingAutoDim: '3-minutes',
            singleTapAgentKeys: true,
          },
          agentSource: 'recent',
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

    expect(screen.getByText('AG00')).toBeTruthy();
    expect(screen.getByText('AG05')).toBeTruthy();

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
    expect(mocks.setSettings).toHaveBeenCalledWith({ singleTapAgentKeys: false });
  });

  it('restores all device settings to their defaults', () => {
    render(<WorkLouderCodexSettings onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.shortcuts.reset' }));

    expect(mocks.setSettings).toHaveBeenCalledWith({
      lightingBrightness: 100,
      lightingAutoDim: '3-minutes',
      singleTapAgentKeys: true,
    });
  });
});
