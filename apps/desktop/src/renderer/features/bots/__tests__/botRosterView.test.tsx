// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }) }));
// Creation tests supply a local-only location catalog; device presence is covered by the route hook tests.
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: () => ({ devices: [], leadAgentDeviceId: null }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  BotModelSelectionRequiredError: class extends Error {},
  addBotProfileAndWait: vi.fn(),
  generateDraft: vi.fn(),
  galleryPortrait: vi.fn(async (_index: number) => 'data:image/png;base64,cG9ydHJhaXQ='),
  defaultModel: 'cindy-selected-model',
  withDefaultBackup: false,
  navigate: vi.fn(),
  onboarding: false,
  availableVendors: new Set(['cc', 'codex', 'pi']),
  profiles: [] as Array<{ id: string; name: string; invitation: { stage: string }; sourceTask?: { sourceSessionId: string } }>,
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
  subscribeBotGlobalModel: () => () => {},
  getEffectiveBotModelChain: () => mocks.defaultModel ? [{ harness: 'codex', model: mocks.defaultModel, providerId: 'openai', effort: 'high', fastMode: false }, ...(mocks.withDefaultBackup ? [{ harness: 'pi', model: 'hidden-backup', providerId: 'backup-provider', effort: 'high', fastMode: false }] : [])] : [],
  refreshBotProfiles: vi.fn(),
  retryBotInvitation: vi.fn(),
  getEffectiveBotModelSettings: () => ({
    model: 'custom-model',
    providerId: 'custom',
    effort: 'high',
    fastMode: false,
  }),
}));
vi.mock('@/components/new-chat/ModelSelector', async () => {
  const { Popover, PopoverContent, PopoverTrigger } = await import('@/components/ui/popover');
  return {
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
        <Popover>
          <PopoverTrigger>open-model-panel</PopoverTrigger>
          <PopoverContent>
            <div data-testid="provider-list" style={{ overflowY: 'auto', height: 100 }}>
              <button type="button">Provider row</button>
            </div>
            <div data-testid="model-list" style={{ overflowY: 'auto', height: 100 }}>
              <button type="button">Model row</button>
            </div>
          </PopoverContent>
        </Popover>
      </>
    ),
  };
});
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('../BotPortraitPicker', () => ({
  BOT_PORTRAIT_COUNT: 17,
  BotPortraitPicker: ({ value, onChange }: { value?: string; onChange: (value: string) => void }) => <button type="button" data-testid="portrait" onClick={() => onChange('data:image/png;base64,bWFudWFs')}>{value}</button>,
  galleryPortrait: mocks.galleryPortrait,
}));

import { BotRosterView } from '../BotRosterView';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

beforeEach(() => {
  setDataOwnerGeneration('fixture-owner');
  mocks.galleryPortrait.mockClear();
  mocks.defaultModel = 'cindy-selected-model';
  mocks.withDefaultBackup = false;
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('name-only creation', () => {
  it.each([false, true])('restores the provider-setup draft after unmount (inline=%s), then discards it on cancel', async inline => {
    const first = render(<BotRosterView inline={inline} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByTestId('portrait'));
    fireEvent.click(screen.getByRole('button', { name: 'choose-custom-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'connect-source' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=providers');
    first.unmount();
    const returned = render(<BotRosterView />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep me');
    expect(screen.getByTestId('portrait').textContent).toBe('data:image/png;base64,bWFudWFs');
    expect(screen.getByTestId('selected-engine').textContent).toBe('pi');
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    returned.unmount();
    render(<BotRosterView />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('does not restore a setup draft across an account transition', () => {
    const first = render(<BotRosterView />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Private draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'connect-source' }));
    first.unmount();
    setDataOwnerGeneration('another-owner');
    render(<BotRosterView />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('randomizes across all 17 portraits per new form, not by roster length', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = render(<BotRosterView inline />);
    await waitFor(() => expect(mocks.galleryPortrait).toHaveBeenCalledWith(0));
    random.mockReturnValue(0.9999);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cindy' } });
    first.rerender(<BotRosterView inline />);
    expect(mocks.galleryPortrait).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<BotRosterView inline />);
    await waitFor(() => expect(mocks.galleryPortrait).toHaveBeenLastCalledWith(16));
  });

  it('does not replace a manual choice when the initial random image arrives late', async () => {
    let complete!: (value: string) => void;
    mocks.galleryPortrait.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<BotRosterView inline />);
    fireEvent.click(screen.getByTestId('portrait'));
    await act(async () => complete('data:image/png;base64,cmFuZG9t'));
    expect(screen.getByTestId('portrait').textContent).toBe('data:image/png;base64,bWFudWFs');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cindy' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith({ name: 'Cindy', description: '', avatarImageBase64: 'bWFudWFs', prepareInvitation: true }));
  });

  it('creates immediately with the chosen portrait and without a draft/model override', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mika' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
    expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith({ name: 'Mika', description: '', avatarImageBase64: 'cG9ydHJhaXQ=', prepareInvitation: true });
    expect(mocks.generateDraft).not.toHaveBeenCalled();
  });

  // Real trial: retrying an associated task looked like a failed creation. Unit UI regression:
  // one linked profile must show its name and open it, without another create request.
  it('offers the existing source companion explicitly and closes after opening it', async () => {
    mocks.profiles = [{ id: 'existing', name: 'Editor', invitation: { stage: 'ready' }, sourceTask: { sourceSessionId: 'source' } }];
    const onClose = vi.fn();
    await act(async () => { render(<BotRosterView sourceTask={{ id: 'source', title: 'Novel' } as import('@/lib/ccAgent.types').Session} onClose={onClose} />); });
    expect(screen.queryByRole('button', { name: 'bots.guided.generate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /bots.market.open.*Editor/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/existing');
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps default-chain inheritance but saves only the visible explicit model: selected=%s', async selected => {
    mocks.withDefaultBackup = true;
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mika' } });
    if (selected) fireEvent.click(screen.getByRole('button', { name: 'choose-custom-model' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const input = mocks.addBotProfileAndWait.mock.calls[0][0];
    if (selected) {
      expect(input.capabilities.modelChainOverride).toEqual([
        { harness: 'pi', model: 'custom-model', providerId: 'custom', effort: 'high', fastMode: false },
      ]);
      expect(input.capabilities.modelChain).toEqual(input.capabilities.modelChainOverride);
    } else expect(input.capabilities).toBeUndefined();
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
    fireEvent.click(screen.getByRole('button', { name: 'choose-custom-codex-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
    expect(mocks.addBotProfileAndWait).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Mika', avatarImageBase64: 'cG9ydHJhaXQ=',
      capabilities: expect.objectContaining({ modelChainOverride: [{ harness: 'codex', model: 'custom-model', providerId: 'custom', effort: 'high', fastMode: false }] }),
    }));
  });

  it('allows selecting a model before creating when there is no usable default', async () => {
    mocks.defaultModel = '';
    render(<BotRosterView inline />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mika' } });
    fireEvent.click(screen.getByRole('button', { name: 'choose-custom-model' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: expect.objectContaining({ harness: 'pi', model: 'custom-model', providerId: 'custom' }),
    })));
  });

  it('renders creation directly in the empty state and prevents duplicate names', async () => {
    mocks.profiles = [{ id: 'existing', name: 'Mika', invitation: { stage: 'ready' } }];
    render(<BotRosterView inline />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Mika ' } });
    expect((screen.getByRole('button', { name: 'bots.guided.generate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });

  it('allows wheel events in the portaled provider and model lists while locking the background', async () => {
    render(<BotRosterView />);
    await waitFor(() => expect(mocks.galleryPortrait).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'open-model-panel' }));
    for (const id of ['provider-list', 'model-list']) {
      const list = screen.getByTestId(id);
      // jsdom has no layout; supply dimensions but let the real Dialog/Popover
      // and react-remove-scroll decide whether to cancel the browser's wheel.
      Object.defineProperties(list, {
        scrollHeight: { value: 1000 },
        clientHeight: { value: 100 },
        scrollTop: { value: 400, writable: true },
      });
      expect(
        screen.getByRole('button', { name: 'open-model-panel' }).closest('[role="dialog"]')?.contains(list),
      ).toBe(false);
    }
    for (const name of ['Provider row', 'Model row']) {
      for (const deltaY of [-50, 50]) {
        const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
        fireEvent(screen.getByRole('button', { name }), wheel);
        expect(wheel.defaultPrevented).toBe(false);
      }
    }
    const backgroundWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
    fireEvent(document.body, backgroundWheel);
    expect(backgroundWheel.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog', { name: 'bots.guided.title' })).toBeTruthy();
  });
});
