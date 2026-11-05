/**
 * Feishu / Lark URL policy for the official Cindy bot binding.
 *
 * The feishu-hook server supplies a short-lived web authorization link (the
 * app's OAuth authorize page) and an AppLink that opens a chat with the bot.
 * Main re-validates the complete URL immediately before shell.openExternal and
 * before a pending link enters any renderer-visible snapshot; renderer input is
 * never treated as a URL authority. Exact host allowlists keep credentials,
 * alternate hosts, ports, fragments and query smuggling away from the shell
 * boundary. Deliberately not shared with telegramDeepLink / xDeepLink: the
 * accepted URL shapes have nothing in common and a merged allowlist only
 * widens every provider.
 *
 * Feishu (China) and Lark (international) are two brands of one platform; the
 * brand follows the organisation's app, not the Cindy edition, so both host
 * families are accepted on every build.
 */

export class FeishuLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuLinkValidationError';
  }
}

/** Feishu / Lark app id (`cli_` + opaque id); also the binding scopeId. */
export const FEISHU_APP_ID_RE = /^cli_[A-Za-z0-9_]{1,64}$/;

/** Web authorization page hosts (Feishu, Lark). */
const FEISHU_AUTHORIZE_HOSTS = ['accounts.feishu.cn', 'accounts.larksuite.com'] as const;
const FEISHU_AUTHORIZE_PATH = '/open-apis/authen/v1/authorize';
const FEISHU_AUTHORIZE_REQUIRED_PARAMS = ['client_id', 'redirect_uri', 'state'] as const;
/**
 * Optional parameters the platform documents for this endpoint. `response_type`
 * may only be `code`; PKCE is only accepted as a complete S256 pair; anything
 * else is an unexpected parameter.
 */
const FEISHU_AUTHORIZE_OPTIONAL_PARAMS = [
  'response_type',
  'scope',
  'code_challenge',
  'code_challenge_method',
] as const;

/** AppLink hosts that open a chat with a bot (Feishu, Lark). */
const FEISHU_APPLINK_HOSTS = ['applink.feishu.cn', 'applink.larksuite.com'] as const;
const FEISHU_BOT_OPEN_PATH = '/client/bot/open';

function fail(reason: string): never {
  throw new FeishuLinkValidationError(reason);
}

function parseUrl(input: string, invalidMessage: string): URL {
  try {
    return new URL(input);
  } catch {
    return fail(invalidMessage);
  }
}

/** Shared shell-boundary checks; returns the accepted (lower-case) host. */
function validateBase(url: URL, input: string, hosts: readonly string[]): string {
  if (input.trim() !== input) fail('Feishu link must not include surrounding whitespace');
  if (url.protocol !== 'https:') fail('Feishu link must use HTTPS');
  if (!hosts.includes(url.hostname)) {
    fail(`Feishu link host must be exactly one of: ${hosts.join(', ')}`);
  }
  // URL normalizes an explicit default :443 port away, so inspect the raw
  // authority as well before handing a link to Electron's shell.
  const authority = /^[A-Za-z]+:\/\/([^/?#]+)/.exec(input)?.[1];
  if (authority?.toLowerCase() !== url.hostname) {
    fail('Feishu link must not include credentials or a port');
  }
  if (url.port) fail('Feishu link must not include a port');
  if (url.username || url.password) fail('Feishu link must not include credentials');
  // URL.hash is also '' for an explicit trailing '#'; inspect the source so
  // even an empty fragment is excluded from the canonical shell boundary.
  if (input.includes('#')) fail('Feishu link must not include a fragment');
  return url.hostname;
}

/** Every key at most once, no empty values, nothing outside the allowlist. */
function readParams(
  url: URL,
  allowed: readonly string[],
  label: string,
): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (!allowed.includes(key)) fail(`${label} contains an unexpected parameter: ${key}`);
    if (params.has(key)) fail(`${label} repeats parameter: ${key}`);
    if (value.length === 0) fail(`${label} parameter must not be empty: ${key}`);
    params.set(key, value);
  }
  return params;
}

export interface ValidFeishuConnectLink {
  url: string;
  /** The Feishu / Lark app the user is asked to authorize. */
  appId: string;
}

/** Parse the only URL shape accepted for a Feishu / Lark bind attempt. */
export function parseFeishuConnectUrl(input: string): ValidFeishuConnectLink {
  const url = parseUrl(input, 'Invalid Feishu binding URL');
  validateBase(url, input, FEISHU_AUTHORIZE_HOSTS);
  if (url.pathname !== FEISHU_AUTHORIZE_PATH) {
    fail(`Feishu binding URL path must be exactly ${FEISHU_AUTHORIZE_PATH}`);
  }
  const params = readParams(
    url,
    [...FEISHU_AUTHORIZE_REQUIRED_PARAMS, ...FEISHU_AUTHORIZE_OPTIONAL_PARAMS],
    'Feishu binding URL',
  );
  for (const key of FEISHU_AUTHORIZE_REQUIRED_PARAMS) {
    if (!params.has(key)) fail(`Feishu binding URL is missing parameter: ${key}`);
  }
  const appId = params.get('client_id')!;
  if (!FEISHU_APP_ID_RE.test(appId)) fail('Feishu binding URL has an invalid client_id');
  // The callback belongs to the hook server (a localhost http address in
  // development); it only has to be an absolute http(s) URL here — the
  // platform itself enforces the app's registered redirect allowlist.
  const redirect = parseUrl(params.get('redirect_uri')!, 'Feishu binding URL has an invalid redirect_uri');
  if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
    fail('Feishu binding URL redirect_uri must be an http(s) URL');
  }
  const responseType = params.get('response_type');
  if (responseType !== undefined && responseType !== 'code') {
    fail('Feishu binding URL response_type must be code');
  }
  const hasChallenge = params.has('code_challenge');
  const challengeMethod = params.get('code_challenge_method');
  if (hasChallenge !== (challengeMethod !== undefined)) {
    fail('Feishu binding URL must send code_challenge and code_challenge_method together');
  }
  if (challengeMethod !== undefined && challengeMethod !== 'S256') {
    fail('Feishu binding URL must use the S256 PKCE challenge');
  }
  return { url: url.toString(), appId };
}

/** Parse an AppLink that opens a chat with the bound Feishu / Lark bot. */
export function parseFeishuBotUrl(input: string): string {
  const url = parseUrl(input, 'Invalid Feishu bot link');
  validateBase(url, input, FEISHU_APPLINK_HOSTS);
  if (url.pathname !== FEISHU_BOT_OPEN_PATH) {
    fail(`Feishu bot link path must be exactly ${FEISHU_BOT_OPEN_PATH}`);
  }
  const params = readParams(url, ['appId'], 'Feishu bot link');
  const appId = params.get('appId');
  if (appId === undefined || !FEISHU_APP_ID_RE.test(appId)) {
    fail('Feishu bot link must carry a valid appId');
  }
  return url.toString();
}

/**
 * null-safe variant for server-supplied remediation URLs. The service is shared by many
 * organizations' apps, so the link must also open the bot of the binding's own app
 * (`appId`); invalid links and other apps' bots → null.
 */
export function feishuBotUrlOrNull(input: string | null, appId: string | null): string | null {
  if (input === null || appId === null) return null;
  try {
    const url = parseFeishuBotUrl(input);
    return new URL(url).searchParams.get('appId') === appId ? url : null;
  } catch {
    return null;
  }
}

/** Validate all Feishu / Lark URLs that the Settings actions may hand to Electron shell. */
export function validateFeishuExternalUrl(input: string): string {
  const url = parseUrl(input, 'Invalid Feishu URL');
  if ((FEISHU_APPLINK_HOSTS as readonly string[]).includes(url.hostname)) {
    return parseFeishuBotUrl(input);
  }
  return parseFeishuConnectUrl(input).url;
}
