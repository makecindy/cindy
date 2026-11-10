import { DiscordChannelAccessSection } from '../../../src/renderer/components/settings/DiscordChannelAccessSection';
import { DiscordChannelAccessUnsupportedError } from '../../../src/renderer/hooks/useDiscordChannelAccess';
import { mountPage } from '../../ui-page/harness';

const ALL = { view: true, send: true, readHistory: true, embed: true, attachFiles: true, sendInThreads: true };
const guilds = [
  {
    id: '200000000000000001',
    name: 'Design Team',
    channels: [
      { id: '300000000000000001', name: 'general', permissions: ALL },
      { id: '300000000000000002', name: 'plain', permissions: { ...ALL, readHistory: false, embed: false } },
      { id: '300000000000000003', name: 'locked', permissions: { ...ALL, send: false } },
    ],
  },
  {
    id: '200000000000000002',
    name: 'Reading Club With A Rather Long Server Name',
    channels: [{ id: '300000000000000010', name: 'books', permissions: ALL }],
  },
];
const G1 = '200000000000000001';
const G2 = '200000000000000002';

type Access = { channels: Array<Record<string, unknown>>; guilds?: Array<Record<string, unknown>> };
const accessFor = (name: string): Access => {
  switch (name) {
    case 'all':
      return { channels: [], guilds: [{ guildId: G1, enabled: true, mode: 'all' }] };
    case 'selected':
      // 存量配置：只有 channels、没有服务器条目 = 已开启 + 仅指定频道。
      return { channels: [{ guildId: G1, channelId: '300000000000000001' }] };
    case 'closed-with-selection':
      return {
        channels: [],
        guilds: [
          { guildId: G1, enabled: false, mode: 'selected', savedChannels: [{ channelId: '300000000000000001' }] },
        ],
      };
    case 'mixed':
      return {
        channels: [{ guildId: G2, channelId: '300000000000000010' }],
        guilds: [{ guildId: G1, enabled: true, mode: 'all', allowMembers: true }],
      };
    default:
      return { channels: [] };
  }
};

void mountPage({
  host: (ctx) => {
    const kind = ctx.data.kind as string;
    let access = accessFor(ctx.data.access as string);
    return {
      discordBot: {
        listChannels: async () => {
          if (kind === 'error') throw new Error('offline');
          return { status: { kind: 'connected', appId: 'bot#1' }, guilds: kind === 'empty' ? [] : guilds };
        },
        getChannelAccess: async () => access,
        setChannelAccess: async (next: Access) => (access = next),
      },
    };
  },
  render: (ctx) => {
    const teammate = ctx.data.kind === 'teammate';
    let saved = accessFor(ctx.data.access as string);
    const source = teammate
      ? {
          load: async () => {
            if (ctx.data.unsupported) throw new DiscordChannelAccessUnsupportedError();
            return { guilds, access: saved as never, online: ctx.data.online !== false };
          },
          save: async (next: unknown) => (saved = next as Access) as never,
        }
      : undefined;
    return (
      <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
        <DiscordChannelAccessSection
          connected
          {...(source ? { source, sourceKey: 'device:connection', members: { botName: 'Mia' } } : {})}
        />
      </div>
    );
  },
});
