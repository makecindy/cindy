import { expect, it } from 'vitest';
import { resolveImportReferences } from '../environmentSelection.js';

it('resolves mixed-case Windows references throughout selected MCP and delivery settings', () => {
  const env = { api_key: 'fixture-key', Empty: '' };
  const value = { headers: { Authorization: 'Bearer ${API_KEY}' }, args: ['${Api_Key}', '${EMPTY}'], token: '${api_KEY}', number: 1 };
  expect(resolveImportReferences(value, env, false, 'win32')).toEqual({ headers: { Authorization: 'Bearer fixture-key' }, args: ['fixture-key', ''], token: 'fixture-key', number: 1 });
  expect(env).toEqual({ api_key: 'fixture-key', Empty: '' });
  expect(value.token).toBe('${api_KEY}');
});

it.each(['darwin', 'linux'] as const)('keeps %s environment references case-sensitive', platform => {
  const env = { api_key: 'lower', API_KEY: 'upper' };
  expect(resolveImportReferences(['${api_key}', '${API_KEY}'], env, false, platform)).toEqual(['lower', 'upper']);
  expect(() => resolveImportReferences('${Api_Key}', env, false, platform)).toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
});

it.each(['win32', 'darwin'] as const)('does not resolve absent or inherited variables on %s', platform => {
  const env = Object.assign(Object.create({ TOKEN: 'not-selected' }), { api_key: 'fixture-key' });
  expect(() => resolveImportReferences('${TOKEN}', env, false, platform)).toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
  expect(resolveImportReferences(['${TOKEN}', '${MISSING}', '$(not-executed)'], env, true, platform)).toEqual(['${TOKEN}', '${MISSING}', '$(not-executed)']);
});
