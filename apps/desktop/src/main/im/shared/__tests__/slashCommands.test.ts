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
    detach: vi.fn(),
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

import type { ChannelIM, TextChannelIM } from '@cindy/im';

import { ui } from '../../feishu/uiText';
import { ui as telegramUi } from '../../telegram/uiText';
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
    peekSession: vi.fn(async () => defaultRow),
    peekSessionById: vi.fn(async () => null),
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
    getPermissionModes: vi.fn(() => [
      { id: 'auto', displayName: 'Auto', description: 'Safe default' },
    ]),
    changePermissionMode: vi.fn(),
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
      getCapabilities: () => ({
        permissionModes: [{ id: 'auto', displayName: 'Auto', description: 'Safe default' }],
      }),
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

  it('/exitctr 隐藏别名与 /exctr 同路径 — 归一化后仍走 executeDetach', async () => {
    // 守住注册表 alias 归一化链: 老 switch 的 `case '/exitctr':` label 已删,
    // 等价性依赖 parsePersonalBotCommand 把别名归一到 /exctr — 这里做 dispatch 级兜底。
    const { executeDetach } = await import('../../binding');
    vi.mocked(executeDetach).mockResolvedValue({ wasAttached: true } as never);
    const { handlers } = makeHarness();

    await handlers.handleSlashCommand('/exitctr', { botContextId: 'bot', userId: 'ou_user' });

    expect(executeDetach).toHaveBeenCalledWith(
      { channel: 'feishu', botContextId: 'bot', userId: 'ou_user' },
      'feishu-slash',
    );
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith('ou_user', ui.slash.detachedBySlash);
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

  it('keeps card-only commands unsupported but exposes /permission on a text channel', async () => {
    const textIm = {
      sendMarkdownText: mocks.sendMarkdownText,
    } as unknown as TextChannelIM;
    const turnRunner = makeTurnRunner();
    const { handlers } = makeHarness({
      turnRunner,
      adapterOverrides: {
        channel: 'wecom',
        im: textIm,
        output: {
          kind: 'chunked-text',
          im: textIm,
          commitFinal: vi.fn(),
        },
      },
    });

    for (const command of ['/model', '/ctr', '/session', '/permission']) {
      await handlers.handleSlashCommand(command, {
        botContextId: 'bot',
        userId: 'owner',
      });
    }

    expect(mocks.sendInteractiveCard).not.toHaveBeenCalled();
    expect(turnRunner.resolveRouteTarget).toHaveBeenCalledOnce();
    expect(mocks.sendMarkdownText.mock.calls.slice(0, 3).map(([, text]) => text)).toEqual(
      ['/model', '/ctr', '/session'].map((command) => ui.slash.unknownCommand(command)),
    );
    expect(mocks.sendMarkdownText.mock.calls[3]?.[1]).toContain('/permission auto');
  });

  it('requires text-channel Full Access to pass through the shared confirmation flow', async () => {
    const textIm = { sendMarkdownText: mocks.sendMarkdownText } as unknown as TextChannelIM;
    const changePermissionMode = vi.fn(async () => ({
      kind: 'confirmation-required' as const,
      mode: 'bypassPermissions' as const,
      label: 'Full Access',
    }));
    const turnRunner = makeTurnRunner({
      getPermissionModes: vi.fn(() => [
        { id: 'auto' as const, displayName: 'Auto' },
        { id: 'bypassPermissions' as const, displayName: 'Full Access' },
      ]),
      changePermissionMode,
    });
    const { handlers } = makeHarness({
      turnRunner,
      adapterOverrides: {
        channel: 'wecom',
        im: textIm,
        output: { kind: 'chunked-text', im: textIm, commitFinal: vi.fn() },
      },
    });

    await handlers.handleSlashCommand('/permission bypass', {
      botContextId: 'bot',
      userId: 'owner',
    });

    expect(changePermissionMode).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'feishu-session',
        mode: 'bypassPermissions',
        confirmedFullAccess: false,
      }),
    );
    expect(mocks.sendMarkdownText).toHaveBeenCalledWith(
      'owner',
      expect.stringContaining('/permission bypassPermissions confirm'),
    );
  });

  it('text-only channels explain and skip slash commands that require cards', async () => {
    const unsupported = (cmd: string) => `unsupported:${cmd}`;
    const outputIm = {
      sendMarkdownText: mocks.sendMarkdownText,
    } as unknown as TextChannelIM;
    const { handlers, cards, turnRunner } = makeHarness({
      adapterOverrides: {
        output: {
          kind: 'chunked-text',
          im: outputIm,
          commitFinal: vi.fn(),
        },
        ui: {
          ...ui,
          slash: { ...ui.slash, interactiveCommandUnsupported: unsupported },
        },
      },
    });

    for (const cmd of ['/model', '/permission', '/ctr', '/session', '/project']) {
      await handlers.handleSlashCommand(cmd, {
        botContextId: 'bot',
        userId: 'ou_user',
      });
    }

    expect(mocks.sendMarkdownText.mock.calls).toEqual(
      ['/model', '/permission', '/ctr', '/session', '/project'].map((cmd) => [
        'ou_user',
        unsupported(cmd),
      ]),
    );
    expect(mocks.sendInteractiveCard).not.toHaveBeenCalled();
    expect(cards.buildModelPickerCard).not.toHaveBeenCalled();
    expect(cards.buildPermissionModePickerCard).not.toHaveBeenCalled();
    expect(cards.buildControlPickerCard).not.toHaveBeenCalled();
    expect(cards.buildProjectPickerCard).not.toHaveBeenCalled();
    expect(turnRunner.resolveRouteTarget).not.toHaveBeenCalled();
  });

  const SLASH_CTX = { botContextId: 'bot', userId: 'ou_user' };

  describe('/settings', () => {
    it('Telegram: 按官方 bot 的同一结构给出五项配置', async () => {
      // 官方 bot 的 /settings 是服务端渲染的固定五行(项目 / Agent / 模型 /
      // 强度 / 权限)。个人侧照同一结构给, 两个 bot 的用户看到的是同一份东西。
      // 固件的托管目录恰好等于 defaultRow.workingDir, 这里换一个真项目目录,
      // 才验得到「显示目录名」这条路径。
      const repo = makeRepo({
        peekSession: vi.fn(async () => ({ ...defaultRow, workingDir: 'D:\\work\\XDMaker' })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      expect(await handlers.handleSlashCommand('/settings', SLASH_CTX)).toBe(true);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：XDMaker'); // 目录名, 不是绝对路径
      expect(text).toContain('Agent：claude-code');
      expect(text).toContain('模型：claude-opus-4-8');
      expect(text).toContain('推理强度：xhigh');
      expect(text).toContain('权限：auto');
    });

    it('没有该文案的渠道回未知命令 —— 不硬造一个配置概念', async () => {
      const { handlers } = makeHarness(); // 飞书 ui 没有 settings 文案
      expect(await handlers.handleSlashCommand('/settings', SLASH_CTX)).toBe(true);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('/settings');
      expect(text).not.toContain('claude-opus-4-8');
    });

    it('只读: 不建会话、不复活软删行', async () => {
      // resolveRouteTarget 没有现成会话时会建一条, 其内部的 findActiveSession
      // 还会把软删行翻回 active 并广播 —— 问一句「我现在什么配置」不该有这些
      // 副作用。
      const repo = makeRepo();
      const turnRunner = makeTurnRunner();
      const { handlers } = makeHarness({ repo, turnRunner, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      expect(repo.peekSession).toHaveBeenCalledOnce();
      expect(repo.createSession).not.toHaveBeenCalled();
      expect(repo.prepareNewSession).not.toHaveBeenCalled();
      expect(repo.findActiveSession).not.toHaveBeenCalled();
      expect(turnRunner.resolveRouteTarget).not.toHaveBeenCalled();
    });

    it('还没有会话行时报渠道默认值, 项目名不是空串', async () => {
      const repo = makeRepo({ peekSession: vi.fn(async () => null) });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：对话（托管目录）');
      expect(text).toContain('Agent：claude-code');
      expect(text).not.toContain('项目：\n');
    });

    it('无会话时的默认值走建会话那条解析, 不读静态 adapter.config', async () => {
      // 用户在设置页把新会话默认值改成别的 agent/模型后, adapter.config 还是
      // 出厂那份 —— 照它报就等于告诉用户一个他下一条消息根本得不到的配置, 甚至
      // 可能是已下架的模型。prepareNewSession 走的正是建会话那条默认值解析
      // (readImDefaultSettings + 供应商目录 reconcile), 且只算不写库。
      const prepared: ImSessionRow = {
        ...defaultRow,
        agentKind: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'medium',
        permissionMode: 'plan',
      };
      const repo = makeRepo({
        peekSession: vi.fn(async () => null),
        prepareNewSession: vi.fn(async () => prepared),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      expect(repo.prepareNewSession).toHaveBeenCalledOnce();
      expect(repo.createSession).not.toHaveBeenCalled();
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('Agent：codex');
      expect(text).toContain('模型：gpt-5.6-sol');
      expect(text).toContain('推理强度：medium');
      expect(text).toContain('权限：plan');
    });

    it('/ctr 接管中: 报的是被接管那条会话, 不是接管前的配置', async () => {
      // 接管期间下一条消息、/model、/permission 走的都是 binding 命中的 desktop
      // 会话。总览无条件读 Telegram 自己那行, 就会和同一屏里的其它命令打架。
      const { bindingStore } = await import('../../binding');
      (bindingStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce('attached-session');
      const attached: ImSessionRow = {
        ...defaultRow,
        id: 'attached-session',
        workingDir: 'D:\\work\\Attached',
        model: 'claude-sonnet-5',
        permissionMode: 'plan',
      };
      const repo = makeRepo({ peekSessionById: vi.fn(async () => attached) });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      expect(repo.peekSessionById).toHaveBeenCalledWith('attached-session');
      expect(repo.peekSession).not.toHaveBeenCalled();
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：Attached');
      expect(text).toContain('模型：claude-sonnet-5');
      expect(text).toContain('权限：plan');
    });

    it('POSIX 根目录的项目仍显示成项目, 不被改判成「对话」', async () => {
      // '/' 按分隔符切完一段不剩。取不到末段就回落到「对话」的话, 一个货真价实
      // 的项目会被报成对话 —— listProjectsForControl 并不排除根目录, 它在选择器
      // 里就显示成 '/'。
      const repo = makeRepo({
        peekSession: vi.fn(async () => ({
          ...defaultRow,
          workingDir: '/',
          workspaceKind: 'project' as const,
        })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：/');
      expect(text).not.toContain('项目：对话');
    });

    it('Windows 盘符根目录显示成 C:/, 不缩成 C:', async () => {
      // 切完只剩 `C:` —— 它在 Windows 里指「该盘的当前目录」, 不是根目录, 拿它
      // 当项目名会指向另一个地方。远程控制下一条 Windows 会话完全可能由 macOS
      // 上的主进程渲染, 所以这条不能靠 path.win32 或运行平台兜。
      const repo = makeRepo({
        peekSession: vi.fn(async () => ({
          ...defaultRow,
          workingDir: 'C:/',
          workspaceKind: 'project' as const,
        })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：C:/');
      expect(text).not.toContain('项目：对话');
    });

    it('Windows 项目目录仍取末段, 不受盘符段影响', async () => {
      const repo = makeRepo({
        peekSession: vi.fn(async () => ({
          ...defaultRow,
          workingDir: 'C:\\Users\\chris\\cindy',
          workspaceKind: 'project' as const,
        })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：cindy');
    });

    it('接管的是 desktop 对话会话 → 显示「对话」, 不把内部 UUID 当项目名', async () => {
      // workspaceKind 与路径在 schema 里是解耦的: 一条 dialogue 会话的目录既不是
      // 项目、也不等于本渠道的托管目录(末段常是内部 UUID), 只比对路径判不出来。
      const { bindingStore } = await import('../../binding');
      (bindingStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce('attached-dialogue');
      const repo = makeRepo({
        peekSessionById: vi.fn(async () => ({
          ...defaultRow,
          id: 'attached-dialogue',
          workingDir: 'D:\\dialogues\\9f1c2b7e-0a44-4c1d-9b3e-77d0f2a1c8e5',
          workspaceKind: 'dialogue' as const,
        })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：对话（托管目录）');
      expect(text).not.toContain('9f1c2b7e');
    });

    it('binding 指向的会话已失效 → 回落到渠道自己那行, 只读不 detach', async () => {
      const { bindingStore } = await import('../../binding');
      (bindingStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce('gone-session');
      const repo = makeRepo({
        peekSessionById: vi.fn(async () => null),
        peekSession: vi.fn(async () => ({ ...defaultRow, workingDir: 'D:\\work\\XDMaker' })),
      });
      const { handlers } = makeHarness({ repo, adapterOverrides: { ui: telegramUi } });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      expect(repo.peekSession).toHaveBeenCalledOnce();
      expect(bindingStore.detach).not.toHaveBeenCalled();
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：XDMaker');
    });

    it('目录是渠道托管目录时显示「对话」, 不露内部路径名', async () => {
      // ensureWorkingDir 造的是 `telegram-<botId>` 这种内部目录, 它不是项目名。
      const repo = makeRepo({
        peekSession: vi.fn(async () => ({ ...defaultRow, workingDir: 'F:\\XDMaker' })),
      });
      const { handlers } = makeHarness({
        repo,
        adapterOverrides: {
          ui: telegramUi,
          sessions: {
            source: 'feishu',
            sessionIdFor: () => 'feishu-session',
            defaultTitle: () => 'Feishu',
            ensureWorkingDir: () => 'F:\\XDMaker',
            extraInsertColumns: () => ({}),
          },
        },
      });
      await handlers.handleSlashCommand('/settings', SLASH_CTX);
      const [, text] = mocks.sendMarkdownText.mock.calls.at(-1)!;
      expect(text).toContain('项目：对话（托管目录）');
      expect(text).not.toContain('XDMaker');
    });
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
