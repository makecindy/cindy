import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

mountPage({
  route: '/bots/fixture-cindy?settings=1&settingsPage=channels',
  host: {
    botImConnection: {
      list: async () => ({ connections: [] }),
      listAdoptable: async () => ({ bots: [] }),
      onChanged: subscription('connections'),
      add: forbid('botImConnection.add'),
      adopt: forbid('botImConnection.adopt'),
      remove: forbid('botImConnection.remove'),
    },
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
  },
  render: () => <div className="mx-auto max-w-xl p-4">
    <BotChannelsPage bot={{ id: 'fixture-cindy', name: 'Cindy', status: 'active' } as BotProfile} />
  </div>,
});
