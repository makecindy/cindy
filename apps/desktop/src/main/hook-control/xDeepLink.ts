/**
 * X (Twitter) URL policy for Cindy provider binding.
 *
 * The x-hook server supplies a short-lived OAuth2 (PKCE) authorize link, but
 * main re-validates the complete URL immediately before shell.openExternal.
 * Renderer input is never treated as a URL authority.  This keeps credentials,
 * alternate hosts, ports, fragments and query smuggling away from the shell
 * boundary.  Deliberately not shared with telegramDeepLink: the accepted URL
 * shapes have nothing in common and a merged allowlist only widens both.
 */

export class XLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XLinkValidationError';
  }
}

/** X handles are 1-15 word characters; a leading @ is accepted and stripped. */
export const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const X_HOST = 'x.com';
const X_AUTHORIZE_PATH = '/i/oauth2/authorize';
/** OAuth2 PKCE 授权页要求的精确参数键集(服务端 bind.ts 构造的形状)。 */
const X_AUTHORIZE_REQUIRED_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

function fail(reason: string): never {
  throw new XLinkValidationError(reason);
}

function validateBase(url: URL, input: string): void {
  if (input.trim() !== input) fail('X link must not include surrounding whitespace');
  if (url.protocol !== 'https:') fail('X link must use HTTPS');
  if (url.hostname !== X_HOST) fail(`X link host must be exactly ${X_HOST}`);
  const authority = /^[A-Za-z]+:\/\/([^/?#]+)/.exec(input)?.[1];
  // URL normalizes an explicit default :443 port away, so inspect the raw
  // authority as well before handing a link to Electron's shell.
  if (authority?.toLowerCase() !== X_HOST) {
    fail('X link must not include credentials or a port');
  }
  if (url.port) fail('X link must not include a port');
  if (url.username || url.password) fail('X link must not include credentials');
  // URL.hash is also '' for an explicit trailing '#'; inspect the source so
  // even an empty fragment is excluded from the canonical shell boundary.
  if (input.includes('#')) fail('X link must not include a fragment');
}

export interface ValidXConnectLink {
  url: string;
}

/** Parse the only URL shape accepted for a Cindy X bind attempt. */
export function parseXConnectUrl(input: string): ValidXConnectLink {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('Invalid X binding URL');
  }
  validateBase(url, input);
  if (url.pathname !== X_AUTHORIZE_PATH) {
    fail(`X binding URL path must be exactly ${X_AUTHORIZE_PATH}`);
  }
  // 精确参数集合:每个必需键恰好一次、无未知键 —— 重复/多余键即拒绝,
  // URLSearchParams 的解码宽容不构成放行理由。
  const entries = [...url.searchParams.entries()];
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (!(X_AUTHORIZE_REQUIRED_PARAMS as readonly string[]).includes(key)) {
      fail(`X binding URL contains an unexpected parameter: ${key}`);
    }
    if (seen.has(key)) fail(`X binding URL repeats parameter: ${key}`);
    seen.add(key);
    if (value.length === 0) fail(`X binding URL parameter must not be empty: ${key}`);
  }
  for (const key of X_AUTHORIZE_REQUIRED_PARAMS) {
    if (!seen.has(key)) fail(`X binding URL is missing parameter: ${key}`);
  }
  if (url.searchParams.get('response_type') !== 'code') {
    fail('X binding URL must request the authorization code flow');
  }
  if (url.searchParams.get('code_challenge_method') !== 'S256') {
    fail('X binding URL must use the S256 PKCE challenge');
  }
  return { url: url.toString() };
}

/** Profile URL for the bound bot account; accepts and strips a leading @. */
export function xProfileUrl(handle: string): string {
  const bare = handle.startsWith('@') ? handle.slice(1) : handle;
  if (!X_HANDLE_RE.test(bare)) fail('Invalid X handle');
  return `https://${X_HOST}/${bare}`;
}

/** null-safe 变体:handle 形状不合法时返回 null(缓存恢复等容错路径用)。 */
export function xProfileUrlOrNull(handle: string | null): string | null {
  if (handle === null) return null;
  try {
    return xProfileUrl(handle);
  } catch {
    return null;
  }
}

/** Validate all X URLs that the Settings actions may hand to Electron shell. */
export function validateXExternalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('Invalid X URL');
  }
  validateBase(url, input);
  if (url.pathname === X_AUTHORIZE_PATH) return parseXConnectUrl(input).url;
  const match = /^\/([^/]+)$/.exec(url.pathname);
  const handle = match?.[1] ?? '';
  if (url.pathname.includes('%')) fail('X handle must not be encoded');
  if (url.search !== '' || input.includes('?')) fail('X profile link must not include a query');
  return xProfileUrl(handle);
}
