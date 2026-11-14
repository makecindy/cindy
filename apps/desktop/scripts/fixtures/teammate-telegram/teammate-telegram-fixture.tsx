import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import { BotSettingsTargetContext, type BotSettingsTarget } from '../../../src/renderer/features/bots/botSettingsTarget';
import { localBotSettingsTarget } from '../../../src/renderer/features/bots/localBotSettingsTarget';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import type { BotImConnectionView } from '../../../src/shared/botImConnection';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

/** 场景数据: 只填了 token 的 Telegram 连接, 可带一条私聊过来的配对请求。 */
function connections(data: Record<string, unknown>): BotImConnectionView[] {
  if (!data.connection) return [];
  const now = Date.now();
  return [{
    id: 'a1b2c3d4e5f6',
    botId: 'fixture-cindy',
    channel: 'telegram',
    createdAt: 1,
    botContextId: '7012345678',
    status: { kind: 'connected', appId: '7012345678' },
    identity: {
      username: 'cindy_helper_bot',
      ownerUserId: null,
      pendingOwnerPairings: data.request ? [{
        userId: '5839201746',
        displayName: 'Alexandria Montgomery-Featherstonehaugh 的工作号 · Personal assistant account',
        username: 'alexandria_montgomery_featherstonehaugh',
        requestedAt: now - 30_000,
        expiresAt: now + 14 * 60_000,
      }] : [],
    },
  }];
}

function botImConnection(data: Record<string, unknown>) {
  return {
    list: async () => ({ connections: connections(data) }),
    listAdoptable: async () => ({ bots: [] }),
    onChanged: subscription('connections'),
    add: forbid('botImConnection.add'),
    adopt: forbid('botImConnection.adopt'),
    remove: forbid('botImConnection.remove'),
    approveOwnerPairing: forbid('botImConnection.approveOwnerPairing'),
    dismissOwnerPairing: forbid('botImConnection.dismissOwnerPairing'),
  };
}

const bot = { id: 'fixture-cindy', name: 'Cindy', status: 'active' } as BotProfile;

mountPage({
  route: '/bots/fixture-cindy?settings=1&settingsPage=channels',
  host: (ctx) => ({
    botImConnection: botImConnection(ctx.data),
    openExternal: async () => undefined,
    maker: {
      imDefaultSettingsGet: async () => ({ agentKind: 'codex', agents: { codex: { model: 'gpt-6.1-sol' } } }),
    },
    wechatBot: {
      getState: async () => ({ phase: 'disconnected', bound: false, queuedTasks: 0 }),
      getChannelSettings: async () => ({ version: 1, workingDir: null, workingDirAvailable: true }),
      onStateChange: subscription('wechatState'),
      onChannelSettingsChange: subscription('wechatSettings'),
    },
  }),
  render: (ctx) => {
    const page = <div className="mx-auto max-w-xl p-4"><BotChannelsPage bot={bot} /></div>;
    if (!ctx.data.remote) return page;
    // 伙伴在另一台电脑上: 页面只读那台电脑的连接, 没有配对确认入口。
    const remoteApi = { ...botImConnection(ctx.data), approveOwnerPairing: undefined, dismissOwnerPairing: undefined };
    const target = {
      ...localBotSettingsTarget,
      kind: 'remote',
      deviceId: 'fixture-mac',
      deviceName: 'Studio Mac mini',
      channels: { im: remoteApi, canEnterCredentials: false, wechat: null, x: null },
    } as unknown as BotSettingsTarget;
    return <BotSettingsTargetContext.Provider value={target}>{page}</BotSettingsTargetContext.Provider>;
  },
});
