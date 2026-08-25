import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
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
  /**
   * Fired synchronously after the interaction is accepted from the current
   * Gateway, with the Discord ACK completion exposed separately. Consumers can
   * capture their ingress lease before awaiting the network round trip.
   */
  onButtonInteraction(i: ButtonInteraction, acknowledged: Promise<void>): void;
}

export interface DiscordGateway {
  connect(token: string): Promise<void>;
  /** Close only the Gateway ingress while keeping the REST client alive. */
  closeIngress(): Promise<void>;
  destroy(): Promise<void>;
  readonly client: Client | null;
  readonly ingressOpen: boolean;
  /** True after scheduler ownership explicitly closed ingress on this client. */
  readonly ingressForcedClosed?: boolean;
  readonly appId: string;
  readonly botTag: string;
}

export function createDiscordGateway(ev: DiscordGatewayEvents): DiscordGateway {
  return new DiscordJsGateway(ev);
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
  if (code === 4014) {
    return { kind: 'error', reason: 'Discord gateway rejected configured intents' };
  }
  return { kind: 'connecting' };
}

export function mapDiscordLoginErrorToStatus(error: unknown): IMStatus {
  const code = errorCode(error);
  if (code === 'TokenInvalid' || code === 4004) {
    return { kind: 'error', reason: 'Discord authentication failed: invalid bot token' };
  }
  if (code === 'DisallowedIntents' || code === 4014) {
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
  #ingressOpen = false;
  #ingressForcedClosed = false;
  #appId = '';
  #botTag = '';
  #dedup = createDedup(DEDUP_CAPACITY);

  constructor(private readonly ev: DiscordGatewayEvents) {}

  get client(): Client | null {
    return this.#client;
  }

  get ingressOpen(): boolean {
    return this.#ingressOpen;
  }

  get ingressForcedClosed(): boolean {
    return this.#ingressForcedClosed;
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
    // discord.js keeps the same Client while it performs automatic Gateway
    // recovery. Reusing that client is essential: creating another one here
    // would let the old reconnect and the replacement consume the same Bot.
    if (this.#client) return;

    this.ev.onStatus({ kind: 'connecting' });
    this.#ingressForcedClosed = false;
    this.#ingressOpen = true;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
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
          this.#ingressOpen = false;
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

  async closeIngress(): Promise<void> {
    this.#ingressForcedClosed = true;
    this.#ingressOpen = false;
    const client = this.#client;
    if (!client) return;

    // Client.destroy() also clears the REST token. Handoff must keep accepted
    // turns able to send their final response, so close only the websocket
    // manager here; the owning DiscordIM performs full destroy after draining.
    try {
      await (client.ws as unknown as { destroy(): Promise<void> }).destroy();
    } catch (error) {
      // Closing ingress is best-effort. The ordered handoff must still drain
      // accepted work and call destroy() even if discord.js rejects ws.close.
      try {
        log.warn(`discord gateway ingress close failed: ${errorMessage(error)}`);
      } catch {
        // Logging must not turn a cleanup failure back into a rejected handoff.
      }
    }
  }

  async destroy(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connectPromise = null;
    this.#ingressForcedClosed = false;
    this.#ingressOpen = false;
    this.#appId = '';
    this.#botTag = '';
    if (client) {
      client.destroy();
    }
  }

  #bindClient(client: Client): void {
    client.once(Events.ClientReady, (readyClient) => {
      if (this.#client !== client) return;
      if (this.#ingressForcedClosed) return;
      this.#appId = readyClient.application?.id ?? readyClient.user.id;
      this.#botTag = readyClient.user.tag;
      this.#ingressOpen = true;
      this.ev.onStatus(connectedStatusForBotTag(this.#botTag));
    });

    client.on(Events.MessageCreate, (message) => {
      if (this.#client !== client) return;
      if (!this.#ingressOpen) return;
      if (message.author.id === client.user?.id || message.author.bot) return;
      if (message.channel.type !== ChannelType.DM) return;
      if (this.#dedup.seen(message.id)) return;
      this.ev.onDmMessage(message);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (this.#client !== client) return;
      if (!this.#ingressOpen) return;
      if (!interaction.isButton()) return;
      let acknowledged: Promise<void>;
      try {
        acknowledged = interaction.deferUpdate().then(
          () => undefined,
          () => undefined,
        );
      } catch {
        // The 3s ACK may already be gone; keep the gateway alive either way.
        acknowledged = Promise.resolve();
      }
      // Publish acceptance before awaiting the ACK. Scheduler handoff can happen
      // during that await; the previous lease must still finish this interaction.
      this.ev.onButtonInteraction(interaction, acknowledged);
      await acknowledged;
    });

    client.on(Events.Error, (error) => {
      this.#handleClientError(client, 'client error', error);
    });
    client.on(Events.ShardError, (error, shardId) => {
      this.#handleClientError(client, `shard error shard=${shardId}`, error);
    });
    client.on(Events.ShardDisconnect, (event) => {
      if (this.#client !== client) return;
      const status = mapDiscordCloseCodeToStatus(event.code);
      if (status.kind === 'error') {
        this.#client = null;
        this.#ingressOpen = false;
        this.#appId = '';
        this.#botTag = '';
        client.destroy();
      }
      this.ev.onStatus(status);
    });
    client.on(Events.ShardReconnecting, () => {
      if (this.#client !== client) return;
      this.#ingressOpen = false;
      this.ev.onStatus({ kind: 'connecting' });
    });
    client.on(Events.ShardResume, () => {
      if (this.#client !== client) return;
      if (this.#ingressForcedClosed) return;
      this.#ingressOpen = true;
      this.ev.onStatus(connectedStatusForBotTag(this.#botTag));
    });
    client.on(Events.ShardReady, () => {
      if (this.#client !== client) return;
      if (this.#ingressForcedClosed) return;
      this.#ingressOpen = true;
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

    // Events.Error and Events.ShardError can fire for transient issues (rate
    // limits, momentary network hiccups) while the shard is still healthy and
    // receiving events. Reporting `connecting` in that case incorrectly arms
    // the scheduler's reconnect withdrawal timer and stalls ingress for up to
    // 15s. Only surface `connecting` when the client is no longer usable, as
    // tracked by discord.js itself. See GitHub issue #2971.
    if (client.isReady()) return;

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
