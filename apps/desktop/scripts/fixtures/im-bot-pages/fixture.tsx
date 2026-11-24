import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';

import { ImBotSection } from '../../../src/renderer/components/settings/ImBotSection';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { IM_DEFAULT_SETTINGS } from '../../../src/shared/imDefaultSettings';
import { resolveAutomaticImSettings } from '../../../src/shared/imAutomaticModel';
import { mountPage, subscription } from '../../ui-page/harness';

const provider: ProviderView = {
  ...BUNDLED_CATALOG.providers.find((p) => p.id === 'openai')!,
  connected: true,
  agents: ['codex'],
  access: { kind: 'subscription' },
  models: {
    codex: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 200000, group: 'gpt', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }],
  },
};

const idle = { kind: 'idle' };

/**
 * 主页 + 子页的真实组件, 各渠道状态由宿主接口给出: 微信与 Telegram 已连接, 其它未配置。
 * data.telegramCompanion 决定 Telegram 交给谁回复(null = Cindy)。
 */
void mountPage({
  route: '/settings?tab=im-bot',
  host: (ctx) => {
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), {
      dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation,
      providers: [provider],
      providerOrder: ['openai'],
    });
    const settings = {
      ...resolveAutomaticImSettings(IM_DEFAULT_SETTINGS, [provider])!,
      automaticModel: true,
      isCustomized: false,
      customizedKeys: [],
      defaults: IM_DEFAULT_SETTINGS,
    };
    let telegramCompanion: string | null = ctx.data.telegramCompanion ?? null;
    // 侧栏里的本机项目; data.telegramProject 是 Telegram 选中的项目目录(null = 对话)。
    const projects = [{ dir: '/Users/me/Projects/demo-shop', name: 'demo-shop' }, { dir: '/Users/me/Projects/notes', name: 'notes' }];
    const channelProject: Record<string, string | null> = { telegram: ctx.data.telegramProject ?? null };
    const channelState = (channel: string) => ({
      channel, projectDir: channelProject[channel] ?? null, companionBotId: channel === 'telegram' ? telegramCompanion : null, projects,
    });
    const prefs = [{ workspace: 'demo-shop', agentKind: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'auto' }];
    // 「群聊」总表: 一个跟随的群、一个单独选了项目并开放给群成员的群、一个群成员已暂停的群。
    const projectToken = 'a'.repeat(24);
    const chat = (chatId: string, name: string, extra: Record<string, unknown> = {}) => ({
      chatId, kind: 'group', name, avatarUrl: null, project: null, route: null, permissionMode: null,
      members: false, membersPaused: false, ...extra,
    });
    let chats = [
      chat('-1001', '产品讨论组', {
        project: { token: projectToken, name: 'demo-shop', available: true, config: { route: null, permissionMode: 'auto' } },
        members: true,
      }),
      chat('-1002', '周末徒步群', { members: true, membersPaused: true }),
      chat('-1003', '家里人'),
    ];
    const chatList = () => ({
      channel: 'telegram', connected: true, source: 'local', listError: null, chats,
      projects: [{ token: projectToken, name: 'demo-shop', permissionMode: 'auto' }], channelProject: null,
    });
    return {
      deviceLink: {
        listDevices: async () => ({ devices: [] }),
        onPresenceChanged: subscription('presence'),
        onControlTargetChanged: subscription('controlTarget'),
        onStatusChanged: subscription('deviceLinkStatus'),
      },
      maker: {
        imDefaultSettingsGet: async () => settings,
        imChatSettingsList: async () => chatList(),
        imChatSettingsSet: async (_channel: string, chatId: string, patch: Record<string, unknown>) => {
          chats = chats.map((item) => (item.chatId === chatId ? { ...item, ...('members' in patch ? { members: patch.members, membersPaused: false } : {}) } : item));
          return chats.find((item) => item.chatId === chatId);
        },
        imChatSettingsResumeMembers: async (_channel: string, chatId: string) => {
          chats = chats.map((item) => (item.chatId === chatId ? { ...item, membersPaused: false } : item));
          return chats.find((item) => item.chatId === chatId);
        },
        listAvailableAgents: async () => ['claude-code', 'codex', 'pi'],
        getCapabilities: async () => ({
          availableModels: provider.models.codex.map((m) => ({ ...m, displayName: m.name })),
          effortLevels: [],
          permissionModes: [{ id: 'auto', displayName: 'Auto' }],
          turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] },
        }),
        onProvidersChanged: subscription('providers'),
      },
      botImConnection: {
        getPersonalReplyTarget: async ({ channel }: { channel: string }) => ({ channel, companionBotId: channel === 'telegram' ? telegramCompanion : null }),
        setPersonalReplyTarget: async ({ channel, companionBotId: next }: { channel: string; companionBotId: string | null }) => {
          if (channel === 'telegram') telegramCompanion = next;
          return { channel, companionBotId: next };
        },
        onPersonalReplyTargetChanged: subscription('replyTarget'),
        getPersonalChannel: async ({ channel }: { channel: string }) => channelState(channel),
        setPersonalChannelProject: async ({ channel, projectDir }: { channel: string; projectDir: string | null }) => {
          channelProject[channel] = projectDir;
          return channelState(channel);
        },
        onPersonalChannelChanged: subscription('personalChannel'),
      },
      telegramBot: {
        getStatus: async () => ({ status: { kind: 'connected', appId: '7712345678' }, ownerUserId: '5512345678', botUsername: 'cindy_home_bot' }),
        onStatusChange: subscription('telegram-status'),
        getBehavior: async () => ({ emojiReactions: 'minimal', replyQuoteGroup: 'first', replyQuoteDm: 'off' }),
        getPersona: async () => ({ botName: 'Cindy', soul: '' }),
        listGroups: async () => ({ groups: [] }),
      },
      wechatBot: {
        getState: async () => ({ phase: 'connected', bound: true, queuedTasks: 0 }),
        getChannelSettings: async () => ({ version: 1, workingDir: null, workingDirAvailable: true }),
        onStateChange: subscription('wechat-state'),
        onChannelSettingsChange: subscription('wechat-settings'),
      },
      discordBot: {
        getStatus: async () => ({ status: idle, ownerUserId: null, lifecycleAnnouncement: false }),
        onStatusChange: subscription('discord-status'),
      },
      feishuBot: {
        getState: async () => ({ status: 'idle', appId: null, appSecret: null, hasSecret: false, ownerOpenId: null, lifecycleAnnouncement: false }),
        onStatusChange: subscription('feishu-status'),
        onRegistrationStatus: subscription('feishu-registration'),
      },
      wecomBot: {
        getStatus: async () => ({ status: idle, botId: null, ownerUserId: null }),
        onStatusChange: subscription('wecom-status'),
      },
      wecomGroupNotification: { getState: async () => ({ configured: false, enabled: false }) },
      dingtalkBot: {
        getState: async () => ({ status: idle, appKey: null, hasSecret: false, ownerUserId: null }),
        onStatusChange: subscription('dingtalk-status'),
        onOwnerChange: subscription('dingtalk-owner'),
      },
      hookControl: {
        getSharedProjectPrefs: async () => ({ prefs: { prefs } }),
        onSharedProjectPrefsChanged: subscription('hook-shared-prefs'),
        getWorkspaceProviderSources: async () => ({ entries: [] }),
        onWorkspaceProviderSourcesChanged: subscription('hook-sources'),
        onTelegramBehaviorChanged: subscription('telegram-behavior'),
        listTelegramGroups: async () => ({ groups: [] }),
      },
    };
  },
  render: () => (
    <ConfirmDialogProvider>
      <main className="min-h-screen bg-[var(--surface)] px-8 py-8 text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[720px]">
          <ImBotSection targetGroup={null} />
        </div>
      </main>
    </ConfirmDialogProvider>
  ),
});
