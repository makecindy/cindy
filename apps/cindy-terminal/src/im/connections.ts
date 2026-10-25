import fs from 'node:fs';
import { createTerminalCompanionIm } from './companions.js';
import { createTerminalWechat } from './wechat.js';
import { TerminalFeishuRegistration } from './registration.js';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { WecomGroupNotificationService } from '@cindy/im-runtime/wecomGroupNotification';
import { createScheduleNotifier } from '@cindy/app-runtime/scheduleNotifier';
import type { TerminalDeviceService } from '../remote/service.js';
import path from 'node:path';
import { createDiscordIM, createWecomIM, createDingTalkIM, createTelegramIM, createFeishuIM, type TelegramIMOptions, type DiscordIMOptions, type BaseIM, type FeishuIM } from '@cindy/im';
import { buildFeishuAdapter } from '@cindy/im-runtime/channels/feishu/adapter';
import { createFeishuUiText } from '@cindy/im-runtime/channels/feishu/uiText';
import { createFeishuNotifications } from '@cindy/im-runtime/channels/feishu/notificationOrigin';
import { createTerminalFeishuTools } from './feishu-tools.js';
import { channelPermissionUnavailable, telegramCommandDescription, type Locale } from '../ui/i18n.js';
import { buildPersonalBotCommandMenu } from '@cindy/im-runtime/botCommands';
import { buildTelegramAdapter } from '@cindy/im-runtime/channels/telegram/adapter';
import { telegramUiText } from '@cindy/im-runtime/channels/telegram/uiText';
import { createTelegramSpeakerRegistration } from '@cindy/im-runtime/channels/telegram/contacts';
import { createTelegramBotMcpServer } from '@cindy/im-runtime/telegramBotMcpServer';
import { createGroupHistoryMcpServer } from '@cindy/im-runtime/groupHistoryMcpServer';
import type { TerminalKnowledge } from '../knowledge.js';
import { TerminalTelegramSettings } from './telegram-settings.js';
import { buildDingTalkAdapter, dingtalkManagedWorkingDirName } from '@cindy/im-runtime/channels/dingtalk/adapter';
import { buildWecomAdapter } from '@cindy/im-runtime/channels/wecom/adapter';
import { WecomTextInteractions } from '@cindy/im-runtime/channels/wecom/textInteractions';
import { buildDiscordAdapter } from '@cindy/im-runtime/channels/discord/adapter';
import { discordUiText } from '@cindy/im-runtime/channels/discord/uiText';
import { IM_DEFAULT_SETTINGS, IM_DEFAULT_EFFORT_OVERRIDES } from '@cindy/im-runtime/imDefaultSettings';
import { TerminalImTransportHost } from './transport-host.js';
import { TerminalGroupWindows } from './group-window.js';
export const TERMINAL_IM_CHANNELS = ['discord', 'wecom', 'dingtalk', 'telegram', 'feishu'] as const;
export type TerminalImChannel = typeof TERMINAL_IM_CHANNELS[number] | 'wechat';
const configurationChannels = {
  feishu: { read: 'feishuBot:get-state', save: 'feishuBot:save', disconnect: 'feishuBot:clear' },
  discord: { read: 'discordBot:get-status', save: 'discordBot:set-config', disconnect: 'discordBot:disconnect' },
  wecom: { read: 'wecomBot:get-status', save: 'wecomBot:set-config', disconnect: 'wecomBot:disconnect' },
  dingtalk: { read: 'dingtalkBot:get-state', save: 'dingtalkBot:save', disconnect: 'dingtalkBot:clear' },
  telegram: { read: 'telegramBot:get-status', save: 'telegramBot:set-config', disconnect: 'telegramBot:disconnect' },
  wechat: { read: 'wechatBot:get-state', save: 'wechatBot:authorize', disconnect: 'wechatBot:unbind' },
};

/** Each connection uses the official transport with the same owner-scoped
 * task runtime. No transport module imports Electron or starts a renderer. */
export class TerminalImConnections {
  companionRuntime?: Awaited<ReturnType<typeof createTerminalCompanionIm>>;
  wechatRuntime?: Awaited<ReturnType<typeof createTerminalWechat>>;
  readonly transport: TerminalImTransportHost;
  readonly registration: TerminalFeishuRegistration;
  readonly feishu;
  readonly notifications;
  readonly wecomGroup;
  readonly discord;
  readonly wecom;
  readonly dingtalk;
  readonly telegram;
  readonly telegramSettings: TerminalTelegramSettings;
  readonly groups: TerminalGroupWindows;
  private readonly connections: Array<BaseIM & Pick<FeishuIM, 'onStatusChange'>>;
  private readonly subscriptions: Array<() => void> = [];
  private revision = 0;
  private closing?: Promise<void>;
  private starting?: Promise<void>;
  constructor(private readonly options: ConstructorParameters<typeof TerminalImTransportHost>[0] & { knowledge?: TerminalKnowledge; language?: () => Locale; remote?: TerminalDeviceService; hasUnrecoveredMatchingFailure?(run: ScheduleRun): Promise<boolean> }, private readonly native: { discord?: DiscordIMOptions; telegram?: TelegramIMOptions; wecomGroupFetch?: typeof fetch } = {}) {
    this.transport = new TerminalImTransportHost({ ...options, emit: (channel, payload) => {
      if (channel === 'feishuBot:registration-status') { this.registration?.receive(payload); return; }
      options.emit(channel, payload);
    } });
    this.registration = new TerminalFeishuRegistration((channel, input) => this.transport.invoke(channel, input));
    this.wecomGroup = new WecomGroupNotificationService(native.wecomGroupFetch ?? fetch, this.transport.host.secrets, { account: options.tasks.channelControl.account, log: options.logger });
    this.groups = new TerminalGroupWindows(options.root, options.assertCurrent, options.logger);
    this.notifications = createFeishuNotifications({ account: options.tasks.channelControl.account, log: options.logger,
      captureStore: () => this.groups.notificationStore(async id => {
        const row = await options.tasks.storage.get(id);
        return row ? { workingDir: row.workDir, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active' } : null;
      }),
    });
    this.feishu = createFeishuIM(this.transport.host);
    options.tasks.configureChannelTools((context, metadata) => {
      const getSessionContext = () => {
        if (this.closing) throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
        options.assertCurrent(); return context();
      };
      return {
        cindy_feishu_bot: () => createTerminalFeishuTools({ getSessionContext, source: metadata.source, tasks: options.tasks, personal: this.feishu, notifications: this.notifications,
          getCompanionTransport:(id,owner)=>this.companionRuntime?.getBotFeishuTransport(id,owner)??null }),
        cindy_telegram_bot: () => createTelegramBotMcpServer({ getSessionContext }, options.logger),
        cindy_group_history: () => createGroupHistoryMcpServer({ getSessionContext, search: this.groups.search }, options.logger),
      };
    });
    void this.groups.ready.catch(() => {}); // start() reports initialization failures.
    this.discord = createDiscordIM(this.transport.host, {
      ...native.discord,
      resolveImageUrl: url => { const file = this.transport.host.media!.resolveMediaUrl(url); if (!file) throw new Error('INVALID_MEDIA_URL'); return file; },
      expiredCardNotice: discordUiText.expiredCardNotice,
    });
    this.wecom = createWecomIM(this.transport.host);
    this.dingtalk = createDingTalkIM(this.transport.host);
    this.telegramSettings = new TerminalTelegramSettings(options.root, options.assertCurrent);
    void this.telegramSettings.ready.catch(() => {});
    this.telegram = createTelegramIM(this.transport.host, { ...native.telegram,
      commandMenu: buildPersonalBotCommandMenu(key => telegramCommandDescription(options.language?.() ?? 'en', key)),
      resolveImageUrl: url => { const file = this.transport.host.media!.resolveMediaUrl(url); if (!file) throw new Error('INVALID_MEDIA_URL'); return file; },
      expiredCardNotice: telegramUiText.expiredCardNotice, behavior: () => this.telegramSettings.behavior(),
    });
    this.connections = [this.discord, this.wecom, this.dingtalk, this.telegram, this.feishu];
    const config = { agentKind: IM_DEFAULT_SETTINGS.agentKind, defaultModel: IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
      defaultPermissionMode: IM_DEFAULT_SETTINGS.permissionMode, effortOverrides: IM_DEFAULT_EFFORT_OVERRIDES };
    options.tasks.channelOrchestrators.attach(buildFeishuAdapter(this.feishu, config, {
      log: options.logger, ui: createFeishuUiText(() => channelPermissionUnavailable(options.language?.() ?? 'en')),
      readImDefaultSettings: channel => options.tasks.channelDefaults.read(channel),
      resolveFeishuNotificationReply: this.notifications.resolveFeishuNotificationReply,
      requestUtilityText: (prompt, opts) => options.tasks.requestChannelUtilityText('feishu', prompt, opts),
      ensureWorkingDir: appId => {
        options.assertCurrent(); if (!/^[\w-]{1,128}$/.test(appId)) throw new Error('INVALID_IM_CONTEXT');
        const directory = path.join(options.root, 'im-working-dir', appId);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    options.tasks.channelOrchestrators.attach(buildDiscordAdapter(this.discord, config, appId => {
      options.assertCurrent();
      if (!/^[\w-]{1,128}$/.test(appId)) throw new Error('INVALID_IM_CONTEXT');
      const directory = path.join(options.root, 'im-working-dir', `discord-${appId}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      return directory;
    }));
    options.tasks.channelOrchestrators.attach(buildWecomAdapter(this.wecom, new WecomTextInteractions(this.wecom), config, {
      log: options.logger, window: this.groups.channel('wecom-personal'), ensureWorkingDir: botId => {
        options.assertCurrent();
        const directory = path.join(options.root, 'im-working-dir', `wecom-${Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96)}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    options.tasks.channelOrchestrators.attach(buildDingTalkAdapter(this.dingtalk, config, {
      log: options.logger, window: this.groups.channel('dingtalk-personal'), ensureWorkingDir: appKey => {
        options.assertCurrent();
        const directory = path.join(options.root, 'im-working-dir', dingtalkManagedWorkingDirName(appKey));
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    const telegramWindow = this.groups.channel('telegram-personal');
    const contacts = createTelegramSpeakerRegistration({
      enabled: () => options.knowledge?.snapshot().contacts === true,
      getStore: () => { options.assertCurrent(); if (!options.knowledge) throw new Error('CONTACTS_DISABLED'); return options.knowledge.contacts.getStore(); },
      changed: () => options.emit('maker:remote-resources:changed', { collectionId: 'contacts' }), log: options.logger,
    });
    options.tasks.channelOrchestrators.attach(buildTelegramAdapter(this.telegram, config, {
      buildTelegramGroupContextPrefix: args => telegramWindow.buildContextPrefix(args),
      readTelegramPersona: () => this.telegramSettings.persona(),
      autoRegisterTelegramSpeaker: contacts.autoRegisterTelegramSpeaker,
      ensureWorkingDir: botId => {
        options.assertCurrent(); if (!/^\d+$/.test(botId)) throw new Error('INVALID_IM_CONTEXT');
        const directory = path.join(options.root, 'im-working-dir', `telegram-${botId}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    this.subscriptions.push(this.telegram.onGroupWindowMessage(entry => {
      const account = options.tasks.channelControl.account, generation = account.captureImAccountGeneration();
      if (generation === null) return;
      void account.runInImAccountGeneration(generation, () => telegramWindow.record(entry)).catch(() => options.logger.warn('IM_GROUP_HISTORY_RECORD_FAILED'));
    }));
    const ipc = this.transport.host.ipc;
    ipc.handle('telegramBot:get-behavior', () => this.telegramSettings.behavior());
    ipc.handle('telegramBot:set-behavior', patch => this.telegramSettings.patchBehavior((patch ?? {}) as Parameters<TerminalTelegramSettings['patchBehavior']>[0]));
    ipc.handle('telegramBot:get-persona', () => this.telegramSettings.persona());
    ipc.handle('telegramBot:set-persona', async input => {
      const payload = (input ?? {}) as { botName?: string; soul?: string; syncProfile?: boolean };
      const persona = await this.telegramSettings.patchPersona({
        ...(typeof payload.botName === 'string' ? { botName: payload.botName } : {}),
        ...(typeof payload.soul === 'string' ? { soul: payload.soul } : {}),
      });
      return { persona, ...(payload.syncProfile === true ? { profileSynced: await this.telegram.syncBotProfileName(persona.botName) } : {}) };
    });
    ipc.handle('telegramBot:list-groups', async () => {
      const groups = await telegramWindow.listKnownGroups(this.telegram.botContextId), activation = this.telegramSettings.behavior().groupActivation ?? {};
      return { groups: groups.map(group => ({ ...group, activation: activation[group.chatId] ?? 'mention' })) };
    });
    ipc.handle('telegramBot:set-group-activation', payload => {
      const input = (payload ?? {}) as { chatId?: string; mode?: string };
      return this.telegramSettings.activate(input.chatId ?? '', input.mode === 'always' ? 'always' : 'mention');
    });
    for (const connection of this.connections) {
      connection.registerIpc();
      this.subscriptions.push(connection.onStatusChange(() => {
        this.revision += 1;
        options.emit('maker:remote-resources:changed', { collectionId: 'channels' });
      }));
    }
  }
  async connectCompanions() {
    if(this.companionRuntime)return;
    const options=this.options;
    const wechat=await createTerminalWechat({tasks:options.tasks,transport:this.transport,root:options.root,
      logger:options.logger,guard:options.assertCurrent,emit:options.emit});
    try{
      const contacts=createTelegramSpeakerRegistration({
        enabled:()=>options.knowledge?.snapshot().contacts===true,
        getStore:()=>{options.assertCurrent();if(!options.knowledge)throw new Error('CONTACTS_DISABLED');return options.knowledge.contacts.getStore();},
        changed:()=>options.emit('maker:remote-resources:changed',{collectionId:'contacts'}),log:options.logger,
      });
      this.companionRuntime=await createTerminalCompanionIm({tasks:options.tasks,transport:this.transport,groups:this.groups,
        root:options.root,logger:options.logger,guard:options.assertCurrent,locale:()=>options.language?.()??'en',
        wechatSettings:wechat.settings,removeWechatCompanionBinding:wechat.removeCompanionBinding,
        resolveFeishuNotificationReply:this.notifications.resolveFeishuNotificationReply,
        telegram:{readTelegramPersona:()=>this.telegramSettings.persona(),autoRegisterTelegramSpeaker:contacts.autoRegisterTelegramSpeaker},
        telegramOptions:this.native.telegram,
      });
      wechat.connect(this.companionRuntime);this.wechatRuntime=wechat;
    }catch(error){await wechat.close();throw error;}
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    return this.starting = (async () => {
      this.options.assertCurrent();
      await Promise.all([this.groups.ready, this.telegramSettings.ready]);
      if (this.closing) return;
      const results = await Promise.allSettled(this.connections.map(connection => connection.init()));
      if(this.wechatRuntime)results.push(...await Promise.allSettled([this.wechatRuntime.start()]));
      if(this.companionRuntime)results.push(...await Promise.allSettled([this.companionRuntime.startBotImConnections()]));
      if (this.closing) return;
      this.options.assertCurrent();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'IM_CONNECTION_START_FAILED');
    })();
  }
  version() { return this.revision; }
  channelIds():TerminalImChannel[]{return [...TERMINAL_IM_CHANNELS,...(this.wechatRuntime?['wechat' as const]:[])];}
  get wechat(){if(!this.wechatRuntime)throw new Error('WECHAT_NOT_READY');return this.wechatRuntime.im;}
  channel(id: string): TerminalImChannel {
    if (!this.channelIds().includes(id as TerminalImChannel)) throw new Error('IM_CHANNEL_NOT_FOUND');
    return id as TerminalImChannel;
  }
  status(id: TerminalImChannel) { return this[id].getStatus(); }
  readConfiguration(id: TerminalImChannel) { return this.invoke(configurationChannels[id].read, undefined); }
  async saveConfiguration(id: string, input: unknown) {
    if (id === 'wecom-group') {
      if (!input || typeof input !== 'object') throw new Error('INVALID_CONFIGURATION');
      const value = input as { webhookUrl?: unknown; testMessage?: unknown };
      if (typeof value.webhookUrl !== 'string' || typeof value.testMessage !== 'string') throw new Error('INVALID_CONFIGURATION');
      await this.withAccount(generation => this.wecomGroup.saveAndTest(value.webhookUrl as string, value.testMessage as string,
        () => this.options.tasks.channelControl.account.isImAccountGenerationCurrent(generation)));
      this.revision += 1; this.options.emit('maker:remote-resources:changed', { collectionId: 'channels' }); return;
    }
    const result = await this.invoke(configurationChannels[this.channel(id)].save, input) as { saveErrorStatus?: unknown; status?: { kind?: string }; verdict?: string };
    if (result.saveErrorStatus || result.status?.kind === 'error' || result.verdict === 'error' || result.verdict === 'conflict') throw new Error('IM_CONFIGURATION_SAVE_FAILED');
  }
  withAccount<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    this.options.assertCurrent();
    const account = this.options.tasks.channelControl.account, generation = account.captureImAccountGeneration();
    if (generation === null || this.closing) throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
    return account.runInImAccountGeneration(generation, () => operation(generation));
  }
  async notificationAction(action: string, input: unknown) {
    const values = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    await this.withAccount(async generation => {
      if (action === 'enabled' && typeof values.enabled === 'boolean') this.wecomGroup.setEnabled(values.enabled);
      else if (action === 'disconnect') this.wecomGroup.clear();
      else if (action === 'test' && typeof values.testMessage === 'string') await this.wecomGroup.test(values.testMessage, () => this.options.tasks.channelControl.account.isImAccountGenerationCurrent(generation));
      else throw new Error('INVALID_ACTION');
    });
    this.revision += 1; this.options.emit('maker:remote-resources:changed', { collectionId: 'channels' });
  }
  async notify(schedule: Schedule, run: ScheduleRun): Promise<void> {
    await this.withAccount(async generation => {
      const current = () => { this.options.assertCurrent(); if (!this.options.tasks.channelControl.account.isImAccountGenerationCurrent(generation)) throw new Error('IM_ACCOUNT_SCOPE_CLOSED'); };
      current();
      const { DesktopNotifier } = createScheduleNotifier({
        getMobileNotifyGeneration: () => { current(); return this.options.remote?.getNotificationGeneration() ?? generation; },
        sendMobileSessionNotify: payload => { current(); return this.options.remote?.notifications.sendMobileSessionNotify(payload) ?? false; },
        showDesktopSessionEvent: (_window, payload) => { current(); this.options.emit('terminal:notification', {
          id: run.id, ...payload, text: run.resultText ?? run.errorMsg ?? run.status,
        }); },
      });
      await new DesktopNotifier({ getMainWindow: () => null, feishuIm: this.feishu, logger: this.options.logger,
        shouldNotifyDesktop: () => true, isAgentIslandEnabled: () => false,
        hasUnrecoveredMatchingFailure: this.options.hasUnrecoveredMatchingFailure,
        sendFeishuSessionNotification: async (id, text) => { current(); await this.notifications.sendFeishuSessionNotification(this.feishu, id, text); },
        wecomGroupPublisher: { publishMarkdown: text => { current(); return this.wecomGroup.publishMarkdown(text); } },
      }).notify(schedule, run);
    });
  }
  disconnect(id: TerminalImChannel) { return this.invoke(configurationChannels[id].disconnect, undefined); }
  accepts(channel: string) { return this.transport.channels().includes(channel); }
  async invoke(channel: string, input: unknown) {
    const result = await this.transport.invoke(channel, input);
    if (!channel.endsWith(':get-status') && !channel.endsWith(':get-state')) this.revision += 1;
    return result;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const registration = this.registration.close();
    // Close event admission before awaiting gateway shutdown. Active requests
    // keep their old task owner, and all listeners are detached by the runtime.
    const handlers = this.options.tasks.channelControl.close();
    for (const stop of this.subscriptions.splice(0)) stop();
    return this.closing = (async () => {
      const results = await Promise.allSettled([
        registration,
        ...(this.wechatRuntime?[this.wechatRuntime.close()]:[]),
        ...(this.companionRuntime?[this.transport.disposeConnection(()=>this.companionRuntime!.stopBotImConnections())]:[]),
        this.options.tasks.channelOrchestrators.close(),
        ...this.connections.map(connection => this.transport.disposeConnection(() => connection.dispose())),
      ]);
      // Initialization may have been waiting on network I/O when shutdown
      // began. Drain it and dispose any late connection before releasing data.
      await this.starting?.catch(() => {});
      results.push(...await Promise.allSettled(this.connections.map(connection => this.transport.disposeConnection(() => connection.dispose()))));
      await handlers;
      this.transport.close();
      await Promise.all([this.groups.close(), this.telegramSettings.close(), this.wecomGroup.close()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'IM_CONNECTION_CLEANUP_FAILED');
    })();
  }
}
