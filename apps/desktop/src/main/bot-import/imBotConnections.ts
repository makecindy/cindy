import { createLogger } from '../logger.js';
import {
  addBotImConnection,
  assertBotImConnectionAddable,
  findBotImConnectionByIdentity,
  parseBotImConnectionAddInput,
} from '../im/shared/botImConnectionRuntime.js';
import type { BotImConnectionAddInput } from '../../shared/botImConnection.js';
import { object } from './types.js';

const log = createLogger('bot-import:im-bot');

/** Long enough for a still-running source gateway to answer Telegram polling with 409. */
const TELEGRAM_CONFLICT_WINDOW_MS = 5_000;

/** The companion's side of one imported bot. Connection runtime errors become advisory issue codes. */
export interface ImportedImBotTarget {
  channel: BotImConnectionAddInput['channel'];
  /** A connection with the same platform identity: this companion's (an earlier attempt) or another's. */
  existing(): 'self' | 'other' | undefined;
  /** Checks that need no network, before the source bot is stopped. */
  preflight(): Promise<string | undefined>;
  connect(): Promise<string | undefined>;
}

const string = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function issueOf(channel: string, error: unknown): string {
  // IPC errors read "[CODE] message"; the runtime's messages carry codes and platform reasons, never the token.
  const message = error instanceof Error ? error.message : '';
  const issue = /\bownerUserId is invalid\b/.test(message) ? 'IMPORT_IM_BOT_OWNER_MISSING'
    : /\b(TOKEN_IN_USE|APP_IN_USE):/.test(message) ? 'IMPORT_IM_BOT_IN_USE'
      : /\bCONNECT_FAILED: conflict$/.test(message) ? 'IMPORT_IM_BOT_GATEWAY_RUNNING'
        : 'IMPORT_IM_BOT_CONNECT_FAILED';
  log.warn(`imported ${channel} bot connection not created: ${issue}`);
  return issue;
}

/**
 * Resolve an imported credential (references already expanded) into the companion's add input.
 * Returns an issue code when it cannot become a connection; secrets never reach logs or the result.
 */
export function importedImBotTarget(botId: string, credential: { format: string; value: unknown }): ImportedImBotTarget | string {
  const value = object(credential.value);
  const channel = credential.format;
  if (!['telegram', 'discord', 'feishu', 'wecom', 'dingtalk'].includes(channel)) return 'IMPORT_IM_BOT_CONNECT_FAILED';
  const owner = string(value.ownerUserId);
  // Without a known owner the companion would adopt whoever messages the bot first.
  if (!owner) return 'IMPORT_IM_BOT_OWNER_MISSING';
  let input: BotImConnectionAddInput;
  try {
    input = parseBotImConnectionAddInput({ botId, channel, token: value.token, ownerUserId: owner, appId: value.appId, appSecret: value.appSecret,
      service: value.service, wecomBotId: value.wecomBotId, secret: value.secret, appKey: value.appKey });
  } catch (error) { return issueOf(channel, error); }
  const identity = input.channel === 'telegram' || input.channel === 'discord' ? input.token
    : input.channel === 'feishu' ? input.appId : input.channel === 'wecom' ? input.wecomBotId : input.appKey;
  return {
    channel: input.channel,
    existing() {
      const found = findBotImConnectionByIdentity(input.channel, identity);
      return found ? found.botId === botId ? 'self' : 'other' : undefined;
    },
    async preflight() {
      try { await assertBotImConnectionAddable(input); return undefined; } catch (error) { return issueOf(input.channel, error); }
    },
    async connect() {
      try {
        // Feishu / WeCom / DingTalk carry the source's owner instead of waiting for the first private chat.
        await addBotImConnection(input, { ...(owner && input.channel !== 'telegram' && input.channel !== 'discord' ? { ownerUserId: owner } : {}),
          rejectConflictWithinMs: input.channel === 'telegram' ? TELEGRAM_CONFLICT_WINDOW_MS : 0 });
        return undefined;
      } catch (error) { return issueOf(input.channel, error); }
    },
  };
}

/**
 * Connect an imported Telegram / Discord bot as the companion's own connection (controllers
 * without the bots category; the source bot is not stopped). Returns an advisory issue code
 * instead of throwing: the import keeps the credential for delivery either way.
 */
export async function connectImportedImBot(botId: string, credential: { format: string; value: unknown }): Promise<string | undefined> {
  if (credential.format !== 'telegram' && credential.format !== 'discord') return undefined;
  const target = importedImBotTarget(botId, credential);
  if (typeof target === 'string') return target;
  try {
    // Retried imports find the connection they already created.
    const existing = target.existing();
    if (existing) return existing === 'self' ? undefined : 'IMPORT_IM_BOT_IN_USE';
  } catch (error) { return issueOf(target.channel, error); }
  return target.connect();
}
