// @vitest-environment jsdom
// Character picker is a disclosure (owner request, 2026-11-07): the card shows only the
// current character until opened, but a settings search that lands on a character must
// never leave the list hidden. Unit tier: real component, settings hook mocked.

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentIslandSettings } from '../AgentIslandSection.settings-search';
import { SettingsSearchNavigationContext } from '../SettingsSearchNavigation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAgentIslandSettings', () => ({
  useAgentIslandSettings: () => ({
    enabled: false,
    setEnabled: vi.fn(),
    subtleReminders: false,
    subtleRemindersCustomized: false,
    setSubtleReminders: vi.fn(),
    resetSubtleReminders: vi.fn(),
    liveActivity: true,
    liveActivityCustomized: false,
    liveActivitySupported: true,
    setLiveActivity: vi.fn(),
    resetLiveActivity: vi.fn(),
    soundSettings: { enabled: false, sounds: {} },
    soundCustomized: false,
    mascotSkin: 'cindy',
    displayTarget: { mode: 'all' },
    displayOptions: [],
    setSoundEnabled: vi.fn(),
    setSound: vi.fn(),
    resetSoundSettings: vi.fn(),
    setMascotSkin: vi.fn(),
    setDisplayTarget: vi.fn(),
    previewSound: vi.fn(),
    selectSoundFile: vi.fn(),
    supported: true,
  }),
}));

const { AgentIslandSection } = await import('../AgentIslandSection');

afterEach(cleanup);

const toggle = () => document.querySelector<HTMLButtonElement>(`button[aria-controls="settings-agent-island-skins"]`)!;
const skinList = () => document.getElementById('settings-agent-island-skins');

describe('AgentIslandSection character disclosure', () => {
  it('shows only the current character until opened, also with only the Live Activity on', () => {
    render(<AgentIslandSection />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(skinList()).toBeNull();
    expect(toggle().textContent).toContain('settings.agentIsland.skins.cindy.name');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(skinList()?.querySelectorAll('[aria-pressed]').length).toBeGreaterThan(1);
  });

  it('opens the list when a settings search lands on a character', () => {
    render(
      <SettingsSearchNavigationContext.Provider value={{ entry: agentIslandSettings.skinLabel, activation: 1 }}>
        <AgentIslandSection />
      </SettingsSearchNavigationContext.Provider>,
    );
    expect(skinList()).not.toBeNull();
  });
});
