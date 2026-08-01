import { describe, expect, it } from 'vitest';

import {
  parseXConnectUrl,
  validateXExternalUrl,
  xProfileUrl,
  xProfileUrlOrNull,
} from '../xDeepLink';

const AUTHORIZE_QS =
  'response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fx-hook.example%2Fx%2Foauth%2Fcallback&scope=tweet.read%20tweet.write&state=state-abc_123&code_challenge=challenge-abc_123&code_challenge_method=S256';
const VALID_AUTHORIZE = `https://x.com/i/oauth2/authorize?${AUTHORIZE_QS}`;

describe('parseXConnectUrl', () => {
  it('accepts the canonical X OAuth2 (PKCE) authorize URL', () => {
    expect(parseXConnectUrl(VALID_AUTHORIZE).url).toContain('https://x.com/i/oauth2/authorize?');
  });

  it.each([
    ['whitespace padding', ` ${VALID_AUTHORIZE}`],
    ['http downgrade', VALID_AUTHORIZE.replace('https:', 'http:')],
    ['wrong host', VALID_AUTHORIZE.replace('x.com', 'twitter.com')],
    ['host lookalike', VALID_AUTHORIZE.replace('x.com', 'x.com.evil.example')],
    ['embedded credentials', VALID_AUTHORIZE.replace('https://x.com', 'https://user:pw@x.com')],
    ['explicit default port', VALID_AUTHORIZE.replace('https://x.com', 'https://x.com:443')],
    ['fragment', `${VALID_AUTHORIZE}#frag`],
    ['empty fragment delimiter', `${VALID_AUTHORIZE}#`],
    ['wrong path', VALID_AUTHORIZE.replace('/i/oauth2/authorize', '/i/oauth2/authorize/extra')],
    ['unexpected parameter', `${VALID_AUTHORIZE}&prompt=none`],
    ['repeated parameter', `${VALID_AUTHORIZE}&state=state-2`],
    ['missing parameter', VALID_AUTHORIZE.replace('&state=state-abc_123', '')],
    ['empty parameter', VALID_AUTHORIZE.replace('state=state-abc_123', 'state=')],
    ['implicit flow', VALID_AUTHORIZE.replace('response_type=code', 'response_type=token')],
    ['plain PKCE challenge', VALID_AUTHORIZE.replace('code_challenge_method=S256', 'code_challenge_method=plain')],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseXConnectUrl(input)).toThrow(/X (binding URL|link)/);
  });
});

describe('xProfileUrl', () => {
  it('builds the bot profile URL and strips a leading @', () => {
    expect(xProfileUrl('@CindyBot')).toBe('https://x.com/CindyBot');
    expect(xProfileUrl('CindyBot')).toBe('https://x.com/CindyBot');
  });

  it('rejects malformed handles; the null-safe variant swallows them', () => {
    expect(() => xProfileUrl('has space')).toThrow(/Invalid X handle/);
    expect(() => xProfileUrl('way-too-long-handle-x')).toThrow(/Invalid X handle/);
    expect(xProfileUrlOrNull('has space')).toBeNull();
    expect(xProfileUrlOrNull(null)).toBeNull();
    expect(xProfileUrlOrNull('@CindyBot')).toBe('https://x.com/CindyBot');
  });
});

describe('validateXExternalUrl', () => {
  it('accepts the authorize URL and bare profile URLs, nothing else', () => {
    expect(validateXExternalUrl(VALID_AUTHORIZE)).toContain('/i/oauth2/authorize?');
    expect(validateXExternalUrl('https://x.com/CindyBot')).toBe('https://x.com/CindyBot');
    // profile URL 不允许携带 query / 编码路径 / 多段路径
    expect(() => validateXExternalUrl('https://x.com/CindyBot?ref=1')).toThrow();
    expect(() => validateXExternalUrl('https://x.com/%43indyBot')).toThrow();
    expect(() => validateXExternalUrl('https://x.com/CindyBot/status/1')).toThrow();
    expect(() => validateXExternalUrl('https://t.me/CindyBot')).toThrow();
  });
});
