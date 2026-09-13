// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  BotModelSelectionRequiredError: class extends Error {},
  addBotProfileAndWait: vi.fn(),
  generateDraft: vi.fn(),
  defaultModel: 'cindy-selected-model',
  navigate: vi.fn(),
  onboarding: false,
  availableVendors: new Set(['cc', 'codex', 'pi']),
  profiles: [] as Array<{ id: string; name: string; invitation: { stage: string } }>,
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraftForPreferenceSync: () => ({
    vendor: 'codex',
    lastByVendor: { codex: { providerId: 'openai', model: mocks.defaultModel } },
  }),
}));
vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: mocks.onboarding }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: mocks.availableVendors, loaded: true }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => <div>Shared provider setup</div>,
}));
vi.mock('../botStore', () => ({
  BotModelSelectionRequiredError: mocks.BotModelSelectionRequiredError,
  addBotProfileAndWait: mocks.addBotProfileAndWait,
  useBotProfiles: () => mocks.profiles,
  refreshBotProfiles: vi.fn(),
  retryBotInvitation: vi.fn(),
  getEffectiveBotModelSettings: () => ({
    model: 'custom-model',
    providerId: 'custom',
    effort: 'high',
    fastMode: false,
  }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({
    unifiedAgents,
    onUnifiedSelect,
    disabled,
    vendorKey,
    onNavigateToProviders,
  }: {
    onNavigateToProviders?: () => void;
    disabled: boolean;
    vendorKey: string;
    unifiedAgents: string[];
    onUnifiedSelect: (selection: unknown) => void;
  }) => (
    <>
      {onNavigateToProviders && (
        <button type="button" onClick={onNavigateToProviders}>
          connect-source
        </button>
      )}
      <span data-testid="selected-engine">{vendorKey}</span>
      {(['pi', 'codex'] as const)
        .filter((engine) => unifiedAgents.includes(engine))
        .map((engine) => (
          <button
            key={engine}
            disabled={disabled}
            type="button"
            onClick={() =>
              onUnifiedSelect({
                engine,
                providerId: 'custom',
                modelId: 'custom-model',
                effort: 'high',
                fast: false,
              })
            }
          >
            {engine === 'pi' ? 'choose-custom-model' : 'choose-custom-codex-model'}
          </button>
        ))}
    </>
  ),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('../BotPortraitPicker', () => ({
  BotPortraitPicker: () => <div>Portrait picker</div>,
  galleryPortrait: async () => 'data:image/png;base64,cG9ydHJhaXQ=',
}));

import { BotRosterView } from '../BotRosterView';

beforeEach(() => {
  mocks.defaultModel = 'cindy-selected-model';
  mocks.generateDraft.mockReset();
  mocks.generateDraft.mockResolvedValue({
    token: 'draft-1',
    name: 'Mika',
    description: 'Practice English together.',
    skills: [],
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { bots: { generateDraft: mocks.generateDraft } } },
  });
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Ops buddy' });
  mocks.navigate.mockReset();
  mocks.profiles = [];
  mocks.onboarding = false;
  mocks.availableVendors = new Set(['cc', 'codex', 'pi']);
});

afterEach(() => cleanup());

describe('name-only creation', () => {
  it('creates immediately with the chosen portrait and without a draft/model override', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mika' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
    expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith({ name: 'Mika', description: '', avatarImageBase64: 'cG9ydHJhaXQ=', prepareInvitation: true });
    expect(mocks.generateDraft).not.toHaveBeenCalled();
  });

  it('preserves the name when the configured model is unavailable', async () => {
    mocks.addBotProfileAndWait.mockRejectedValueOnce(new mocks.BotModelSelectionRequiredError());
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mika' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Mika');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('renders creation directly in the empty state and prevents duplicate names', async () => {
    mocks.profiles = [{ id: 'existing', name: 'Mika', invitation: { stage: 'ready' } }];
    render(<BotRosterView inline />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Mika ' } });
    expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });
});
