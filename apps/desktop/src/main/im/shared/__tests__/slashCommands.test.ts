import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sendMarkdownText: vi.fn(),
  sendInteractiveCard: vi.fn(),
  resetSessionToDefaults: vi.fn(),
  listProviders: vi.fn(),
  getModelVisibilityOverride: vi.fn(),
  getSessionProvider: vi.fn(),
  getMaker: vi.fn(),
}));

vi.mock('../../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../../maker-host', () => ({ getMaker: mocks.getMaker }));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../../../maker-host/model-visibility-mirror', () => ({
  getModelVisibilityOverride: mocks.getModelVisibilityOverride,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  getSessionProvider: mocks.getSessionProvider,
}));
vi.mock('../sessionRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionRepo')>()),
  resetSessionToDefaults: mocks.resetSessionToDefaults,
}));
vi.mock('../../binding', () => ({
  bindingStore: {
    get: vi.fn(),
    listByIdentity: vi.fn(() => []),
  },
  executeDetach: vi.fn(),
}));
vi.mock('../controlProjects', () => ({
  listProjectsForControl: vi.fn(async () => []),
  readSessionTitle: vi.fn(async () => null),
}));
vi.mock('../controlFlow', () => ({
  startThreadControlFlow: vi.fn(),
}));
vi.mock('../controlState', () => ({
  enterControl: vi.fn(),
}));

import type { ChannelIM } from '@cindy/im';

import { ui } from '../../feishu/uiText';
import { createSlashHandlers } from '../slashCommands';
import type { ImCardBuilders } from '../cardBuilders';
import type { ImSessionRepo, ImSessionRow } from '../sessionRepo';
import type { ImTurnRunner } from '../turnRunner';
import type { ImChannelAdapter } from '../types';

const defaultRow: ImSessionRow = {
  id: 'feishu-session',
  agentKind: 'claude-code',
  workingDir: 'F:\\XDMaker',
  model: 'claude-opus-4-8',
  effort: 'xhigh',
  permissionMode: 'auto',
  fastMode: false,
  sdkSessionId: null,
  providerId: null,
};

function makeRepo(overrides: Partial<ImSessionRepo> = {}): ImSessionRepo {
  return {
    sessionIdFor: vi.fn(() => 'feishu-session'),
    findActiveSession: vi.fn(async () => defaultRow),
    prepareNewSession: vi.fn(async () => defaultRow),
    createSession: vi.fn(async () => defaultRow),
    getDefaultEffortFor: vi.fn(() => 'high' as const),
    ...overrides,
  };
}

function makeTurnRunner(overrides: Partial<ImTurnRunner> = {}): ImTurnRunner {
  return {
    runAgentTurn: vi.fn(),
    resolveRouteTarget: vi.fn(async () => ({ row: defaultRow, attached: false })),
    hasAuthForRoute: vi.fn(async () => true),
    prewireAttachedSession: vi.fn(),
    detachFromSession: vi.fn(),
    disposeAllSessions: vi.fn(),
    disposeOneSession: vi.fn(),
    getMakerSessionById: vi.fn(() => null),
    ...overrides,
  } as unknown as ImTurnRunner;
}

function makeHarness(
  args: {
    repo?: ImSessionRepo;
    turnRunner?: ImTurnRunner;
    adapterOverrides?: Partial<ImChannelAdapter>;
  } = {},
) {
  const adapter: ImChannelAdapter = {
    channel: 'feishu',
    im: {
      sendMarkdownText: mocks.sendMarkdownText,
      sendInteractiveCard: mocks.sendInteractiveCard,
    } as unknown as ChannelIM,
    output: {
      kind: 'rich-card',
      im: {
        sendMarkdownText: mocks.sendMarkdownText,
        sendInteractiveCard: mocks.sendInteractiveCard,
      } as unknown as ChannelIM,
    },
    config: {
      agentKind: 'claude-code',
      defaultModel: 'claude-opus-4-8',
      defaultPermissionMode: 'auto',
    },
    ui,
    sessions: {
      source: 'feishu',
      sessionIdFor: () => 'feishu-session',
      defaultTitle: () => 'Feishu',
      ensureWorkingDir: () => 'F:\\XDMaker',
      extraInsertColumns: () => ({}),
    },
    processingEmoji: 'SMUG',
    buildVendorOptions: () => ({}),
    ...args.adapterOverrides,
  };
  const cards = {
    buildModelPickerCard: vi.fn(() => ({ card: 'model' })),
    buildPermissionModePickerCard: vi.fn(() => ({ card: 'permission' })),
    buildControlPickerCard: vi.fn(),
    buildProjectPickerCard: vi.fn(() => ({ card: 'project' })),
  } as unknown as ImCardBuilders;
  const repo = args.repo ?? makeRepo();
  const turnRunner = args.turnRunner ?? makeTurnRunner();
  const handlers = createSlashHandlers(adapter, repo, cards, turnRunner);
  return { handlers, repo, turnRunner, cards };
}

describe('IM slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMarkdownText.mockResolvedValue(undefined);
    mocks.sendInteractiveCard.mockResolvedValue({ messageId: 'card-1' });
    mocks.listProviders.mockResolvedValue([]);
    mocks.getMaker.mockReturnValue({
      getCapabilities: () => ({ permissionModes: ['auto'] }),
    });
  });

  it('does not create or reset a session when /new defaults are unauthenticated', async () => {
    const repo = makeRepo({
      findActiveSession: vi.fn(async () => defaultRow),
      prepareNewSession: vi.fn(async () => ({ ...defaultRow, model: 'codex/gpt-5.5' })),
      createSession: vi.fn(async () => defaultRow),
    });
    const turnRunner = makeTurnRunner({
      hasAuthForRoute: vi.fn(async () => false),
    });
    const { handlers } = makeHarness({ repo, turnRunner });

    await handlers.handleSlashCommand('/new', {
      botContextId: 'bot',
      userId: 'ou_user',
    });

    expect(repo.createSession).not.toHaveBeenCalled();
    expect(mocks.resetSessionToDefaults).not.toHaveBeenCalled();
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.agent.apiKeyMissing);
  });

  it('explains the persisted provider when /new defaults are unauthenticated', async () => {
    const prepared = { ...defaultRow, agentKind: 'codex' as const, model: 'gpt-5.5' };
    const repo = makeRepo({ prepareNewSession: vi.fn(async () => prepared) });
    const turnRunner = makeTurnRunner({
      getAuthStatusForRoute: vi.fn(async () => ({
        ok: false,
        missing: 'provider-key' as const,
        providerId: 'custom-openai',
        providerLabel: '我的 OpenAI',
      })),
    });
    const { handlers } = makeHarness({ repo, turnRunner });

    await handlers.handleSlashCommand('/new', { botContextId: 'bot', userId: 'ou_user' });

    expect(mocks.sendMarkdownText).toHaveBeenCalledWith(
      'ou_user',
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'custom-openai',
        providerLabel: '我的 OpenAI',
        missing: 'provider-key',
      }),
    );
    expect(mocks.resetSessionToDefaults).not.toHaveBeenCalled();
  });

  it('resets an existing session to the current defaults after /new', async () => {
    const prepared = { ...defaultRow, agentKind: 'codex' as const, model: 'gpt-5.5' };
    const repo = makeRepo({ prepareNewSession: vi.fn(async () => prepared) });
    const { handlers } = makeHarness({ repo });

    await handlers.handleSlashCommand('/new', { botContextId: 'bot', userId: 'ou_user' });

    expect(mocks.resetSessionToDefaults).toHaveBeenCalledWith(
      'feishu-session',
      expect.anything(),
      prepared,
      'feishu',
    );
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.slash.new);
  });

  it('does not send /model picker when creating the target session would fail auth', async () => {
    const turnRunner = makeTurnRunner({
      resolveRouteTarget: vi.fn(async () => null),
    });
    const { handlers, cards } = makeHarness({ turnRunner });

    await handlers.handleSlashCommand('/model', {
      botContextId: 'bot',
      userId: 'ou_user',
    });

    expect(cards.buildModelPickerCard).not.toHaveBeenCalled();
    expect(mocks.sendInteractiveCard).not.toHaveBeenCalled();
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.agent.apiKeyMissing);
  });

  it('does not send /permission picker when creating the target session would fail auth', async () => {
    const turnRunner = makeTurnRunner({
      resolveRouteTarget: vi.fn(async () => null),
    });
    const { handlers, cards } = makeHarness({ turnRunner });

    await handlers.handleSlashCommand('/permission', {
      botContextId: 'bot',
      userId: 'ou_user',
    });

    expect(cards.buildPermissionModePickerCard).not.toHaveBeenCalled();
    expect(mocks.sendInteractiveCard).not.toHaveBeenCalled();
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.agent.apiKeyMissing);
  });

  it('/stop 与 !stop 同语义 — 中止当前 turn 并回执', async () => {
    const stopActiveTurn = vi.fn(async () => ({ stopped: true, droppedQueued: 2 }));
    const turnRunner = makeTurnRunner({ stopActiveTurn } as Partial<ImTurnRunner>);
    const { handlers } = makeHarness({ turnRunner });

    await handlers.handleSlashCommand('/stop', { botContextId: 'bot', userId: 'ou_user' });

    expect(stopActiveTurn).toHaveBeenCalledWith({ botContextId: 'bot', userId: 'ou_user' });
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.agent.stopDone(2));
  });

  it('/start 有欢迎语的渠道回欢迎语, 否则回未知命令', async () => {
    const { handlers } = makeHarness({
      adapterOverrides: {
        ui: { ...ui, slash: { ...ui.slash, start: 'WELCOME' } },
      } as Partial<ImChannelAdapter>,
    });
    await handlers.handleSlashCommand('/start', { botContextId: 'bot', userId: 'ou_user' });
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', 'WELCOME');

    vi.clearAllMocks();
    mocks.sendMarkdownText.mockResolvedValue(undefined);
    const { handlers: plain } = makeHarness();
    await plain.handleSlashCommand('/start', { botContextId: 'bot', userId: 'ou_user' });
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith(
      'ou_user',
      ui.slash.unknownCommand('/start'),
    );
  });

  describe('/project (projectSwitching channels)', () => {
    const projectUi = {
      title: 'P',
      hint: (name: string) => `hint:${name}`,
      emptyBody: 'empty',
      btnDialogue: 'dialogue',
      btnCancel: 'cancel',
      resolvedPick: (n: string) => `picked:${n}`,
      resolvedDialogue: 'back',
      resolvedCancel: 'cancelled',
      switchFailed: (r: string) => `failed:${r}`,
      attachedUnsupported: 'attached-unsupported',
      dialogueName: '对话',
    };
    const projectAdapterOverrides = {
      projectSwitching: true,
      ui: { ...ui, cards: { ...ui.cards, project: projectUi } },
    } as Partial<ImChannelAdapter>;

    it('falls back to unknown-command on channels without projectSwitching', async () => {
      const { handlers, cards } = makeHarness();

      await handlers.handleSlashCommand('/project', { botContextId: 'bot', userId: 'ou_user' });

      expect(cards.buildProjectPickerCard).not.toHaveBeenCalled();
      expect(mocks.sendMarkdownText).toHaveBeenCalledWith(
        'ou_user',
        ui.slash.unknownCommand('/project'),
      );
    });

    it('sends the project picker card with the current directory name', async () => {
      const { handlers, cards } = makeHarness({ adapterOverrides: projectAdapterOverrides });

      await handlers.handleSlashCommand('/project', { botContextId: 'bot', userId: 'ou_user' });

      expect(cards.buildProjectPickerCard).toHaveBeenCalledWith(
        expect.objectContaining({ botAppId: 'bot', currentName: '对话' }),
      );
      expect(mocks.sendInteractiveCard).toHaveBeenCalledWith('ou_user', { card: 'project' });
    });

    it('refuses /project while a /ctr takeover is attached', async () => {
      const { bindingStore } = await import('../../binding');
      (bindingStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce('attached-session');
      const { handlers, cards } = makeHarness({ adapterOverrides: projectAdapterOverrides });

      await handlers.handleSlashCommand('/project', { botContextId: 'bot', userId: 'ou_user' });

      expect(cards.buildProjectPickerCard).not.toHaveBeenCalled();
      expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', 'attached-unsupported');
    });
  });
});
