import { expect, it } from 'vitest';
import { createEnvironmentRedactor, importedProcessEnvironment, redactEnvironmentData, redactEnvironmentValues } from '../process.js';
import { previewImportRedactions } from '../environmentSelection.js';
import { connectionRedactions, importedContentRedactions, redactImportedResult } from '../connectionCatalog.js';

it('reuses a local matcher without changing longest matches, boundaries, callbacks or replacement text', () => {
  const env = { FIRST: 'overlap-secret', LAST: 'overlap-secret', LONG: 'overlap-secret-extended',
    SPECIAL: 'a.*[private]+?', SHORT: 'us', UNICODE: '密钥', COLLISION: 'LAST', LANG: 'en' };
  const matched: string[] = [];
  const redact = createEnvironmentRedactor(env, value => { matched.push(value); });
  const text = 'overlap-secret-extended overlap-secret a.*[private]+? status us 密钥库 密钥 LAST en';
  const expected = '[LONG] [LAST] [SPECIAL] status [SHORT] 密钥库 [UNICODE] [COLLISION] en';
  expect(redact(text)).toBe(expected);
  expect(redact('ordinary words')).toBe('ordinary words');
  expect(redact(text)).toBe(expected);
  expect(matched).toEqual(Array(2).fill(['overlap-secret-extended', 'overlap-secret', 'a.*[private]+?', 'us', '密钥', 'LAST']).flat());
  expect(createEnvironmentRedactor({ OTHER: 'overlap-secret' })('overlap-secret')).toBe('[OTHER]');
  expect(createEnvironmentRedactor({ LANG: 'en', EMPTY: '' })('en ordinary words')).toBe('en ordinary words');
  expect(env.LAST).toBe('overlap-secret');
});

it('reads credentials once while traversing nested keys and values', () => {
  let reads = 0;
  const env = { get API_KEY() { reads++; return 'fixture-private-value'; } };
  const value = { 'fixture-private-value': ['fixture-private-value', { text: 'fixture-private-value', count: 7, enabled: false }] };
  expect(redactEnvironmentData(value, env)).toEqual({ '[API_KEY]': ['[API_KEY]', { text: '[API_KEY]', count: 7, enabled: false }] });
  expect(reads).toBe(1);
  expect(value['fixture-private-value'][0]).toBe('fixture-private-value');
});

it.each(['json', 'command-env'])('limits structured URL decomposition to command env, preserving provider paths (%s)', format => {
  const masks = importedContentRedactions({ env: {}, mcp: [], credentials: [{ id: 'fixture', format,
    value: { base_url: 'https://model.example/codex', api_key: 'fixture-private-key' } }] });
  const output = redactEnvironmentValues('Use codex with fixture-private-key', masks);
  expect(output).not.toContain('fixture-private-key');
  if (format === 'json') expect(output).toContain('Use codex with');
  else expect(output).not.toContain('codex');
});

it('preserves native boolean switches, local bind addresses and transport/policy enums without exempting credentials', () => {
  const env = { BLUEBUBBLES_SEND_READ_RECEIPTS: 'false', BLUEBUBBLES_WEBHOOK_HOST: '192.168.10.100', AWS_BEDROCK_FORCE_HTTP1: '1', BROWSERBASE_PROXIES: 'true', BROWSERBASE_ADVANCED_STEALTH: 'false',
    TELEGRAM_REQUIRE_MENTION: 'true', TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES: 'true', FEISHU_ALLOW_ALL_USERS: 'false',
    WEB_TOOLS_DEBUG: 'false', API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '8080', FEISHU_CONNECTION_MODE: 'websocket', FEISHU_GROUP_POLICY: 'allowlist', FEISHU_BOT_NAME: 'Fixture', FEISHU_DOMAIN: 'feishu' };
  const text = '192.168.10.100 sys.exit(1) action="store_true" <path d="M1 1"/> false 127.0.0.1 8080 websocket allowlist Fixture feishu';
  expect(redactEnvironmentValues(text, env)).toBe(text);
  expect(redactEnvironmentValues('1 true websocket', { ...env, API_KEY: '1', AUTH_ALLOW_DEBUG: 'true', SECRET_MODE: 'websocket' })).toBe('[API_KEY] [AUTH_ALLOW_DEBUG] [SECRET_MODE]');
  const secrets = importedContentRedactions({ env, mcp: [{ name: 'fixture', headers: { Authorization: 'Bearer true' } }], credentials: [] });
  expect(redactEnvironmentValues('true', secrets)).not.toBe('true');
  expect(redactEnvironmentValues('private-endpoint', { API_SERVER_HOST: 'private-endpoint' })).toBe('[API_SERVER_HOST]');
});

it('masks encoded and decoded URL credentials without mutating the private connection', () => {
  const url = 'https://fake%2Fuser:fake%2Bpassword@example.invalid/fake%2Fpath?token=fake%2Bquery';
  const values = [url, 'fake%2Fuser', 'fake/user', 'fake%2Bpassword', 'fake+password', 'fake%2Fpath', 'fake/path', 'fake%2Bquery', 'fake+query'];
  const secrets = importedContentRedactions({ env: { DATA_TOKEN: 'fake-env-token', LANG: 'en', imported_credential_0: 'fake-collision-token' }, mcp: [], credentials: [] }, [url]);
  const output = redactEnvironmentValues(`Ordinary content en. ${values.join(' ')} fake-env-token fake-collision-token`, secrets);
  for (const value of values) expect(output).not.toContain(value);
  expect(output).toContain('Ordinary content en.');
  expect(output).toContain('[DATA_TOKEN]');
  expect(output).not.toContain('fake-collision-token');
});

it.each(['access_token', 'id_token', 'refresh_token'])('masks encoded and decoded %s fragment values while preserving ordinary anchors', field => {
  const secret = 'fixture/fragment+secret';
  const encoded = encodeURIComponent(secret);
  const url = `https://example.invalid/mcp#${field}=${encoded}&token_type=Bearer&section=Introduction&count=7`;
  const server = { name: 'fixture', url };
  const environment = { env: {}, mcp: [server], credentials: [] };
  for (const masks of [connectionRedactions(server, {}), importedContentRedactions(environment),
    importedContentRedactions({ ...environment, mcp: [] }, [url])]) {
    const output = redactEnvironmentValues(`${secret} ${encoded} Bearer Introduction 7`, masks);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encoded);
    expect(output).toContain('Bearer Introduction 7');
  }
  expect(server.url).toBe(url);
  const anchors = connectionRedactions({ name: 'fixture', url: 'https://example.invalid/mcp#getting-started' }, {});
  expect(redactEnvironmentValues('getting-started', anchors)).toBe('getting-started');
});

it('keeps credential context through array and object values without masking ordinary siblings', () => {
  const original = {
    token: ['fixture-first-secret', ['fixture-second-secret', { value: 'fixture-third-secret' }]],
    profile: { api_key: { current: ['fixture-fourth-secret'] }, cities: ['Paris', 'London'] },
    features: ['true', 'false'], count: 7,
  };
  const before = JSON.stringify(original);
  const masks = importedContentRedactions({ env: {}, mcp: [], credentials: [{ id: 'fixture', format: 'json', value: original }] });
  const output = redactEnvironmentValues('fixture-first-secret fixture-second-secret fixture-third-secret fixture-fourth-secret Paris London true false 7', masks);
  for (const secret of ['fixture-first-secret', 'fixture-second-secret', 'fixture-third-secret', 'fixture-fourth-secret']) expect(output).not.toContain(secret);
  expect(output).toContain('Paris London true false 7');
  expect(JSON.stringify(original)).toBe(before);
});

it('preserves OAuth token-type metadata in source files while masking credentials in the same container', () => {
  const tokens = { token_type: 'Bearer', access_token: 'fixture-access-secret', nested: { tokenType: 'DPoP', value: 'fixture-nested-secret' },
    unknown: { token_type: 'fixture-unknown-secret' }, structured: { token_type: ['fixture-array-secret'] } };
  const before = JSON.stringify(tokens);
  const environment = { env: {}, mcp: [], credentials: [{ id: 'fixture', format: 'json', value: { tokens } }] };
  const masks = importedContentRedactions(environment);
  const source = 'Use Bearer or DPoP authorization. fixture-access-secret fixture-nested-secret fixture-unknown-secret fixture-array-secret';
  const output = redactEnvironmentValues(source, masks);
  expect(output).toContain('Use Bearer or DPoP authorization.');
  for (const secret of ['fixture-access-secret', 'fixture-nested-secret', 'fixture-unknown-secret', 'fixture-array-secret']) expect(output).not.toContain(secret);
  expect(JSON.stringify(tokens)).toBe(before);
  // Public metadata never exempts the same literal supplied as an actual token.
  expect(redactEnvironmentValues('Bearer', importedContentRedactions({ ...environment, env: { API_TOKEN: 'Bearer' } }))).not.toBe('Bearer');
});

it.each(['credential', 'credentials', 'clientCredentials', 'tokens', 'access_tokens', 'refreshTokens',
  'secrets', 'passwords', 'passwds', 'keys', 'api_keys', 'API-KEYS', 'auth', 'authorization', 'cookies',
  'private_key', 'privateKey', 'privateKeys', 'SSH_PRIVATE_KEY', 'signing_key', 'signing-key', 'signingKey',
  'privateKeyPem', 'private_key_pem', 'private-key-pem', 'SSH_PRIVATE_KEY_PEM',
  'privateKeyBase64', 'private_keys_base64', 'signingKeyPem', 'signing_key_base64',
  'encryption_key', 'decryptionKey', 'awsSecretAccessKey', 'serviceApiKey', 'passphrase', 'passphrases', 'keyPassphrase', 'pass_phrase', 'pass-phrases'])(
  'masks scalar and nested string descendants of the %s credential field', field => {
    const original = { [field]: ['fixture-container-secret', { nested: ['fixture-nested-secret'] }],
      scalar: { [field]: 'fixture-scalar-secret' }, cities: ['Paris', 'London'], monkeys: ['capuchin'],
      public_key: 'fixture-public-key', sort_key: 'name', keyboard: 'qwerty',
      publicKeyPem: 'fixture-public-pem', public_key_base64: 'fixture-public-base64',
      privateKeyFormat: 'pem', privateKeyPath: 'keys/local.pem' };
    const before = JSON.stringify(original);
    const masks = importedContentRedactions({ env: {}, mcp: [], credentials: [{ id: 'fixture', format: 'json', value: original }] });
    const output = redactEnvironmentValues('fixture-container-secret fixture-nested-secret fixture-scalar-secret Paris London capuchin fixture-public-key name qwerty fixture-public-pem fixture-public-base64 pem keys/local.pem', masks);
    for (const secret of ['fixture-container-secret', 'fixture-nested-secret', 'fixture-scalar-secret']) expect(output).not.toContain(secret);
    expect(output).toContain('Paris London capuchin fixture-public-key name qwerty fixture-public-pem fixture-public-base64 pem keys/local.pem');
    expect(JSON.stringify(original)).toBe(before);
  },
);

it('keeps locale/region configuration and ordinary words intact while masking unknown short credentials as tokens', () => {
  const env = { REGION: 'us', LANG: 'en', LC_ALL: 'en_US.UTF-8', AWS_REGION: 'us-east-1', PRIVATE: 'xy', ARBITRARY: 'fixture-private-value' };
  const value = { status: 'success', language: 'en', region: 'us', detail: 'English status in us-east-1; private xy / fixture-private-value' };
  expect(redactEnvironmentData(value, env)).toEqual({ ...value, detail: 'English status in us-east-1; private [PRIVATE] / [ARBITRARY]' });
  expect(redactEnvironmentValues('status open username us en', { PRIVATE: 'us', UNKNOWN: 'en' })).toBe('status open username [PRIVATE] [UNKNOWN]');
  expect(redactEnvironmentValues('xy_read read_xy xylophone', { PRIVATE: 'xy' })).toBe('[PRIVATE]_read read_[PRIVATE] xylophone');
  // A known locale value does not override an explicit connection credential.
  expect(redactEnvironmentValues('en', connectionRedactions({ name: 'fixture', headers: { Authorization: 'Bearer en' } }, { LANG: 'en' }))).not.toBe('en');
});
it.each(['darwin', 'win32'] as const)('inherits only OS basics and explicit imports on %s', platform => {
  const result = importedProcessEnvironment({ DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy', PATH: 'selected-bin' }, {
    [platform === 'win32' ? 'Path' : 'PATH']: 'host-bin', HOME: 'fixture-home', SystemRoot: 'fixture-system',
    GITHUB_TOKEN: 'fixture-host-token', HTTPS_PROXY: 'fixture-host-proxy', NODE_OPTIONS: '--require=private.js', PYTHONPATH: 'host-private-code',
  }, platform);
  expect(result).toMatchObject({ HOME: 'fixture-home', PATH: 'selected-bin', DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy' });
  expect(result).not.toHaveProperty('GITHUB_TOKEN');
  expect(result).not.toHaveProperty('NODE_OPTIONS');
  expect(result).not.toHaveProperty('PYTHONPATH');
  if (platform === 'win32') { expect(result.SYSTEMROOT).toBe('fixture-system'); expect(result).not.toHaveProperty('Path'); }
});

it('preserves bounded ordinary settings even when deselected, while explicit same-value credentials stay masked', () => {
  const env = { DEBUG: 'true', PORT: '3000', NODE_ENV: 'production', LOG_LEVEL: 'info', VERBOSE: 'false' };
  const text = 'true false 3000 production info';
  const secrets = previewImportRedactions([{ view: { id: 'config', name: 'config', category: 'connections', selected: false }, env }]);
  expect(redactEnvironmentValues(text, secrets)).toBe(text);
  expect(redactEnvironmentData({ true: 'true', port: '3000', number: 3000 }, env)).toEqual({ true: 'true', port: '3000', number: 3000 });
  const privateValues = importedContentRedactions({ env: { ...env, API_KEY: '3000' }, mcp: [{ name: 'data', headers: { Authorization: 'Bearer true' } }], credentials: [] });
  expect(redactEnvironmentValues('true 3000', privateValues)).not.toContain('true');
  expect(redactEnvironmentValues('true 3000', privateValues)).not.toContain('3000');
  expect(redactEnvironmentValues('fixture-private-value', { DEBUG: 'fixture-private-value' })).toBe('[DEBUG]');
});

it('does not turn ordinary scalar settings or MCP endpoint names into content credentials', () => {
  const env = { SOME_FEATURE_ENABLED: 'true', RETRY_COUNT: '1', TEMPERATURE: '0.5' };
  const secrets = importedContentRedactions({ env, mcp: [{ name: 'native-mcp', url: 'http://localhost:9000/native-mcp?enabled=true&retry=1' }, { name: 'touchdesigner-mcp', url: 'http://localhost:9001/touchdesigner-mcp' }], credentials: [] });
  const text = '192.168.10.100 sys.exit(1) action="store_true" <path d="M1 0.5"/> native-mcp touchdesigner-mcp';
  expect(redactEnvironmentValues(text, secrets)).toBe(text);
  expect(redactEnvironmentValues('secret=1', { API_KEY: '1' })).toBe('secret=[API_KEY]');
});

it.each(['abcdefghijklmnop', 'abc', 'mcp', 'native-mcp', 'fake%2Ftoken'])('masks capability path %s in results, errors and readable imports', credential => {
  const server = { name: 'fixture', url: `https://example.invalid/hooks/${credential}` };
  const decoded = decodeURIComponent(credential);
  const result = { isError: true, content: [{ type: 'text', text: `Credential: ${credential}; decoded: ${decoded}` }] };
  for (const masks of [connectionRedactions(server, {}), importedContentRedactions({ env: {}, mcp: [server], credentials: [] })]) {
    const output = JSON.stringify(redactImportedResult(result, masks));
    expect(output).not.toContain(credential);
    expect(output).not.toContain(decoded);
    expect(redactEnvironmentValues(decoded, masks)).not.toBe(decoded);
  }
  expect(server.url).toBe(`https://example.invalid/hooks/${credential}`);
});

it('only exempts explicit routing paths, not arbitrary local or remote path shapes', () => {
  for (const origin of ['http://localhost:9000', 'https://example.invalid']) {
    const masks = connectionRedactions({ name: 'fixture', url: `${origin}/api/v1/mcp/abcdefghijklmnop` }, {});
    expect(redactEnvironmentValues('api v1 mcp', masks)).toBe('api v1 mcp');
    expect(redactEnvironmentValues('abcdefghijklmnop', masks)).not.toBe('abcdefghijklmnop');
  }
  const encodedRoute = connectionRedactions({ name: 'fixture', url: 'https://example.invalid/%68ooks/mcp' }, {});
  expect(redactEnvironmentValues('mcp', encodedRoute)).not.toBe('mcp');
  const explicit = connectionRedactions({ name: 'fixture', url: 'http://localhost:9000/native-mcp', headers: { Authorization: 'Bearer native-mcp' } }, {});
  expect(redactEnvironmentValues('native-mcp', explicit)).not.toBe('native-mcp');
});
