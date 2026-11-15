import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

mountPage({
  route: '/bots/fixture-cindy?settings=1&settingsPage=channels',
  host: (ctx) => {
    let saved = false;
    const connections = ctx.data.imessage ? [{ id: 'aabbccddeeff', botId: 'fixture-cindy', channel: 'imessage',
      createdAt: 1, status: { kind: 'connected', appId: 'fixture' }, identity: { username: null, ownerUserId: null },
      ...(ctx.data.groupEdit ? { botContextId: 'fixture' } : {}) }] : [];
    return {
    botImConnection: {
      list: async () => ({ connections }),
      getIMessageConfig: async () => ({ serverUrl: 'http://192.168.1.20:1234', ownerAddress: 'owner@example.test',
        chatGuids: ['any;-;owner@example.test', ...(ctx.data.groupEdit === 'replace' ? ['any;+;old-group'] : [])], listenHost: '192.168.1.10', listenPort: 18747 }),
      updateIMessageConfig: ctx.data.groupEdit ? async () => { saved = true; return { connections }; } : forbid('botImConnection.updateIMessageConfig'),
      ...(ctx.data.groupEdit ? {
        listGroups: async () => ({ connectionId: 'aabbccddeeff', groups: saved
          ? [{ chatId: 'any;+;new-group', chatName: 'New group', activation: 'mention' }]
          : ctx.data.groupEdit === 'replace' ? [{ chatId: 'any;+;old-group', chatName: 'Old group', activation: 'mention' }] : [] }),
        setGroupActivation: forbid('botImConnection.setGroupActivation'),
      } : {}),
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
    };
  },
  render: () => <div className="mx-auto max-w-xl p-4">
    <BotChannelsPage bot={{ id: 'fixture-cindy', name: 'Cindy', status: 'active' } as BotProfile} />
  </div>,
});
