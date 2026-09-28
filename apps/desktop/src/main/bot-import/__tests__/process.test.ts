import { expect, it } from 'vitest';
import { importedProcessEnvironment, redactEnvironmentData, redactEnvironmentValues } from '../process.js';
import { previewImportRedactions } from '../environmentSelection.js';
import { connectionRedactions, importedContentRedactions } from '../connectionCatalog.js';

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
