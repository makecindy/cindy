import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
} from 'discord.js';
import type { ButtonInteraction, Message } from 'discord.js';

import { defaultLogger } from '../logger.js';
import type { IMStatus } from '../types.js';

const DEDUP_CAPACITY = 512;
const log = defaultLogger('im:discord:gateway');

export interface DiscordGatewayEvents {
  onStatus(s: IMStatus): void;
  onDmMessage(m: Message): void;
  /** 服务器文字频道 / thread 里的用户消息；是否被 @、是否在白名单由上层判定。 */
  onGuildMessage(m: Message): void;
  onButtonInteraction(i: ButtonInteraction): void;
}

export interface DiscordGateway {
  connect(token: string): Promise<void>;
  destroy(): Promise<void>;
  readonly client: Client | null;
  readonly appId: string;
  readonly botTag: string;
}

export function createDiscordGateway(ev: DiscordGatewayEvents): DiscordGateway {
  return new DiscordJsGateway(ev);
}

/** 只接文字频道和已存在的文字 thread；语音 / 论坛 / 公告等频道类型一律不收。 */
const GUILD_MESSAGE_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export function isGuildMessageChannelType(type: number): boolean {
  return GUILD_MESSAGE_CHANNEL_TYPES.has(type);
}

/** 普通消息与回复才算用户发言；入群、置顶、斜杠命令回执等系统类消息不起轮次。 */
export function isUserAuthoredMessageType(type: number): boolean {
  return type === MessageType.Default || type === MessageType.Reply;
}

export function createDedup(cap: number): { seen(id: string): boolean } {
  const ids = new Map<string, true>();

  return {
    seen(id: string): boolean {
      if (ids.has(id)) return true;

      ids.set(id, true);
      while (ids.size > cap) {
        const oldest = ids.keys().next().value;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
      return false;
    },
  };
}

export function mapDiscordCloseCodeToStatus(code: number): IMStatus {
  if (code === 4004) {
    return { kind: 'error', reason: 'Discord authentication failed: invalid bot token' };
  }
  if (code === 4013 || code === 4014) {
    return { kind: 'error', reason: 'Discord gateway rejected configured intents' };
  }
  return { kind: 'connecting' };
}

export function mapDiscordLoginErrorToStatus(error: unknown): IMStatus {
  const code = errorCode(error);
  if (code === 'TokenInvalid' || code === 4004) {
    return { kind: 'error', reason: 'Discord authentication failed: invalid bot token' };
  }
  if (code === 'InvalidIntents' || code === 'DisallowedIntents' || code === 4013 || code === 4014) {
    return { kind: 'error', reason: 'Discord gateway rejected configured intents' };
  }
  return { kind: 'error', reason: errorMessage(error) };
}

export function connectedStatusForBotTag(botTag: string): IMStatus {
  return botTag ? { kind: 'connected', appId: botTag } : { kind: 'connecting' };
}

class DiscordJsGateway implements DiscordGateway {
  #client: Client | null = null;
  #connectPromise: Promise<void> | null = null;
  #appId = '';
  #botTag = '';
  #dedup = createDedup(DEDUP_CAPACITY);

  constructor(private readonly ev: DiscordGatewayEvents) {}

  get client(): Client | null {
    return this.#client;
  }

  get appId(): string {
    return this.#appId;
  }

  get botTag(): string {
    return this.#botTag;
  }

  async connect(token: string): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#client?.isReady()) return;

    this.ev.onStatus({ kind: 'connecting' });
    const client = new Client({
      // GuildMessages 是标准 intent（不要 MessageContent 特权 intent）：服务器里只有
      // @ 到机器人的消息才带正文，正好对应「@ 召唤」，其余消息不会被收集。
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      // 频道里是公共场合：模型或用户文本里的 @everyone / @here / 角色 / 用户都不得真的提醒别人。
      allowedMentions: { parse: [], repliedUser: false },
    });
    this.#client = client;
    this.#dedup = createDedup(DEDUP_CAPACITY);
    this.#bindClient(client);

    const connectPromise = client
      .login(token)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.#client === client) {
          this.ev.onStatus(mapDiscordLoginErrorToStatus(error));
          this.#client = null;
        }
        client.destroy();
        throw error;
      })
      .finally(() => {
        if (this.#connectPromise === connectPromise) {
          this.#connectPromise = null;
        }
      });

    this.#connectPromise = connectPromise;
    return connectPromise;
  }

  async destroy(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connectPromise = null;
    this.#appId = '';
    this.#botTag = '';
    if (client) {
      client.destroy();
    }
  }

  #bindClient(client: Client): void {
    client.once(Events.ClientReady, (readyClient) => {
      if (this.#client !== client) return;
      this.#appId = readyClient.application?.id ?? readyClient.user.id;
      this.#botTag = readyClient.user.tag;
      this.ev.onStatus(connectedStatusForBotTag(this.#botTag));
    });

    client.on(Events.MessageCreate, (message) => {
      if (this.#client !== client) return;
      if (message.author.id === client.user?.id || message.author.bot) return;
      const channelType = message.channel.type;
      if (channelType === ChannelType.DM) {
        if (this.#dedup.seen(message.id)) return;
        this.ev.onDmMessage(message);
        return;
      }
      if (!message.guildId || !isGuildMessageChannelType(channelType)) return;
      if (
        channelType !== ChannelType.GuildText &&
        (!('parent' in message.channel) || message.channel.parent?.type !== ChannelType.GuildText)
      ) return;
      if (message.system || message.webhookId || !isUserAuthoredMessageType(message.type)) return;
      if (this.#dedup.seen(message.id)) return;
      this.ev.onGuildMessage(message);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (this.#client !== client) return;
      if (!interaction.isButton()) return;
      try {
        await interaction.deferUpdate();
      } catch {
        // The 3s ACK may already be gone; keep the gateway alive either way.
      }
      if (this.#client !== client) return;
      this.ev.onButtonInteraction(interaction);
    });

    client.on(Events.Error, (error) => {
      this.#handleClientError(client, 'client error', error);
    });
    client.on(Events.ShardError, (error, shardId) => {
      this.#handleClientError(client, `shard error shard=${shardId}`, error);
    });
    client.on(Events.ShardDisconnect, (event) => {
      if (this.#client !== client) return;
      this.ev.onStatus(mapDiscordCloseCodeToStatus(event.code));
    });
    client.on(Events.ShardReconnecting, () => {
      if (this.#client !== client) return;
      this.ev.onStatus({ kind: 'connecting' });
    });
    client.on(Events.ShardResume, () => {
      if (this.#client !== client) return;
      this.ev.onStatus(connectedStatusForBotTag(this.#botTag));
    });
    client.on(Events.ShardReady, () => {
      if (this.#client !== client) return;
      this.ev.onStatus(connectedStatusForBotTag(this.#botTag));
    });
  }

  #handleClientError(client: Client, label: string, error: unknown): void {
    if (this.#client !== client) return;

    try {
      log.warn(`${label}: ${errorMessage(error)}`);
    } catch {
      // Logging should never make an EventEmitter error handler throw.
    }

    try {
      this.ev.onStatus({ kind: 'connecting' });
    } catch {
      // Keep transient Discord client errors non-fatal even if the host callback fails.
    }
  }
}

function errorCode(error: unknown): string | number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' || typeof code === 'string' ? code : Number(code);
  }
  return 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Discord gateway login failed';
}
