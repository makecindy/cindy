/**
 * Discord URL policy for the official Cindy Discord bot binding.
 *
 * The official bot binds by a one-time code the user sends to the bot (direct
 * message or `/bind`); the server's `connectUrl` only opens Discord's "add app"
 * page and never carries a secret. The bot's user id equals its application id
 * (the binding `scopeId`), so the "open bot" and "add to server" links are
 * built here from that id instead of being taken from the wire.
 *
 * Main re-validates every URL immediately before shell.openExternal and before a
 * pending link enters any renderer-visible snapshot; renderer input is never
 * treated as a URL authority. Exact host / path / query checks keep
 * credentials, alternate hosts, ports, fragments and query smuggling away from
 * the shell boundary. Deliberately not shared with the Telegram / X / Feishu
 * policies: a merged allowlist only widens every provider.
 */

export class DiscordLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordLinkValidationError';
  }
}

/** Discord snowflake (application / user id): 17–20 decimal digits. */
export const DISCORD_SNOWFLAKE_RE = /^[1-9][0-9]{16,19}$/;

const DISCORD_HOST = 'discord.com';
const DISCORD_AUTHORIZE_PATH = '/oauth2/authorize';
/**
 * Guild-install scopes and bot permissions the server documents for the
 * official app: View Channels, Send Messages, Send Messages in Threads, Read
 * Message History, Add Reactions, Attach Files, Embed Links.
 */
const DISCORD_ADD_TO_SERVER_QUERY = 'scope=bot+applications.commands&permissions=274878024768&integration_type=0';

function fail(reason: string): never {
  throw new DiscordLinkValidationError(reason);
}

function parseUrl(input: string, invalidMessage: string): URL {
  try {
    return new URL(input);
  } catch {
    return fail(invalidMessage);
  }
}

function validateBase(url: URL, input: string): void {
  if (input.trim() !== input) fail('Discord link must not include surrounding whitespace');
  if (url.protocol !== 'https:') fail('Discord link must use HTTPS');
  if (url.hostname !== DISCORD_HOST) fail(`Discord link host must be exactly ${DISCORD_HOST}`);
  // URL normalizes an explicit default :443 port away, so inspect the raw
  // authority as well before handing a link to Electron's shell.
  const authority = /^[A-Za-z]+:\/\/([^/?#]+)/.exec(input)?.[1];
  if (authority?.toLowerCase() !== DISCORD_HOST) {
    fail('Discord link must not include credentials or a port');
  }
  if (url.port) fail('Discord link must not include a port');
  if (url.username || url.password) fail('Discord link must not include credentials');
  // URL.hash is also '' for an explicit trailing '#'; inspect the source so
  // even an empty fragment is excluded from the canonical shell boundary.
  if (input.includes('#')) fail('Discord link must not include a fragment');
}

function requireSnowflake(value: string | null | undefined, label: string): string {
  if (typeof value !== 'string' || !DISCORD_SNOWFLAKE_RE.test(value)) fail(`Invalid Discord ${label}`);
  return value;
}

export interface ValidDiscordConnectLink {
  url: string;
  /** The Discord application the user is asked to add. */
  applicationId: string;
}

/** Parse the only URL shape accepted for a pending bind attempt (add the app, no secret). */
export function parseDiscordConnectUrl(input: string): ValidDiscordConnectLink {
  const url = parseUrl(input, 'Invalid Discord binding URL');
  validateBase(url, input);
  if (url.pathname !== DISCORD_AUTHORIZE_PATH) {
    fail(`Discord binding URL path must be exactly ${DISCORD_AUTHORIZE_PATH}`);
  }
  const applicationId = requireSnowflake(url.searchParams.get('client_id'), 'application id');
  // Exact canonical query: duplicate, encoded or extra parameters are rejected
  // even if URLSearchParams would decode them into an apparently valid value.
  if (url.search !== `?client_id=${applicationId}`) fail('Discord binding URL is not canonical');
  return { url: url.toString(), applicationId };
}

/** Opens the official bot's profile so the user can message it. */
export function discordBotUrl(applicationId: string): string {
  return `https://${DISCORD_HOST}/users/${requireSnowflake(applicationId, 'application id')}`;
}

/** Guild install link for the official bot (adds it to a server the user manages). */
export function discordAddToServerUrl(applicationId: string): string {
  const id = requireSnowflake(applicationId, 'application id');
  return `https://${DISCORD_HOST}${DISCORD_AUTHORIZE_PATH}?client_id=${id}&${DISCORD_ADD_TO_SERVER_QUERY}`;
}

/** null-safe variants for snapshot / action paths: a malformed scope yields no link. */
export function discordBotUrlOrNull(applicationId: string | null): string | null {
  if (applicationId === null) return null;
  try {
    return discordBotUrl(applicationId);
  } catch {
    return null;
  }
}

export function discordAddToServerUrlOrNull(applicationId: string | null): string | null {
  if (applicationId === null) return null;
  try {
    return discordAddToServerUrl(applicationId);
  } catch {
    return null;
  }
}

export function isDiscordSnowflake(value: string | null | undefined): value is string {
  return typeof value === 'string' && DISCORD_SNOWFLAKE_RE.test(value);
}

/** Validate all Discord URLs that the Settings actions may hand to Electron shell. */
export function validateDiscordExternalUrl(input: string): string {
  const url = parseUrl(input, 'Invalid Discord URL');
  validateBase(url, input);
  if (url.pathname === DISCORD_AUTHORIZE_PATH) {
    const applicationId = requireSnowflake(url.searchParams.get('client_id'), 'application id');
    if (url.search === `?client_id=${applicationId}`) return parseDiscordConnectUrl(input).url;
    if (url.search === `?client_id=${applicationId}&${DISCORD_ADD_TO_SERVER_QUERY}`) {
      return discordAddToServerUrl(applicationId);
    }
    return fail('Discord authorize link is not canonical');
  }
  if (url.pathname.includes('%')) fail('Discord user id must not be encoded');
  const match = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (match === null) fail('Discord link path is not allowed');
  if (url.search !== '' || input.includes('?')) fail('Discord bot link must not include a query');
  return discordBotUrl(match[1] ?? '');
}
