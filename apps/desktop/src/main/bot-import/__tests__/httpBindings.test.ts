import { expect, it } from 'vitest';
import { importedHttpBases, publicImportHttpBases, resolveImportHttpPath } from '../httpBindings.js';

it('restores aliases only for the chosen base and preserves ordinary relative path semantics', () => {
  const env = { DATA_URL: 'https://data.example.invalid/api/private-token?key=private-query', OTHER_URL: 'https://other.example.invalid/other-secret/' };
  const bases = importedHttpBases({ version: 1, env, mcp: [], credentials: [] }, new Set(Object.keys(env)));
  const projected = publicImportHttpBases(bases);
  const alias = projected[0]!.pathname;
  expect(JSON.stringify(projected)).not.toMatch(/private-token|private-query|other-secret/);
  expect(resolveImportHttpPath(alias, env.DATA_URL, alias).href).toBe(env.DATA_URL);
  expect(resolveImportHttpPath('', env.DATA_URL, alias).href).toBe(env.DATA_URL);
  expect(resolveImportHttpPath(`${alias}/rows`, env.DATA_URL, alias).href).toBe('https://data.example.invalid/api/private-token/rows');
  expect(resolveImportHttpPath('/health', env.DATA_URL, alias).href).toBe('https://data.example.invalid/health');
  expect(resolveImportHttpPath('rows', env.DATA_URL, alias).href).toBe('https://data.example.invalid/api/rows');
  expect(resolveImportHttpPath(projected[1]!.pathname, env.DATA_URL, alias).href).not.toContain('other-secret');
  expect(resolveImportHttpPath('//attacker.invalid/collect', env.DATA_URL, alias).origin).not.toBe(bases[0]!.origin); // Existing origin check rejects it.
  expect(bases[0]!.pathname).toBe('/api/private-token');
});

it('binds each selected service credential to its configured origin, not another selected URL', () => {
  const env = { DATA_URL: 'https://data.example.invalid/v1', DATA_TOKEN: 'fixture-data-key',
    ATTACKER_URL: 'https://unrelated.example.invalid', OPENAI_BASE_URL: 'https://provider.example.invalid/v1', OPENAI_API_KEY: 'fixture-provider-key' };
  const bases = importedHttpBases({ version: 1, env, mcp: [], credentials: [] }, new Set(Object.keys(env)));
  expect(bases.find(base => base.variable === 'DATA_URL')?.authVariables).toEqual(['DATA_TOKEN']);
  expect(bases.find(base => base.variable === 'ATTACKER_URL')?.authVariables).toEqual([]);
  expect(bases.find(base => base.variable === 'OPENAI_BASE_URL')?.authVariables).toEqual(['OPENAI_API_KEY']);
});

it('does not guess between conflicting service origins or bind an arbitrary secret by co-occurrence', () => {
  const env = { DATA_URL: 'https://first.example.invalid', DATA_BASE_URL: 'https://second.example.invalid', DATA_TOKEN: 'fixture-token', PRIVATE: 'fixture-secret' };
  const environment = { version: 1 as const, env, mcp: [], credentials: [] };
  expect(importedHttpBases(environment, new Set(Object.keys(env))).every(base => !base.authVariables.length)).toBe(true);
  // Hiding an alternative URL from the plan cannot erase the configuration ambiguity.
  expect(importedHttpBases(environment, new Set(['DATA_URL', 'DATA_TOKEN']))[0]?.authVariables).toEqual([]);
});

it('uses explicitly configured connection auth for arbitrary variable names without sharing it to other origins', () => {
  const env = { SERVICE_URL: 'https://configured.example.invalid/api', OTHER_URL: 'https://other.example.invalid', PRIVATE: 'fixture-private-value' };
  const environment = { version: 1 as const, env, credentials: [], mcp: [{ name: 'data', url: 'https://configured.example.invalid/mcp', headers: { 'X-Api-Key': env.PRIVATE } }] };
  const bases = importedHttpBases(environment, new Set(Object.keys(env)));
  expect(bases.find(base => base.variable === 'SERVICE_URL')?.authVariables).toEqual(['PRIVATE']);
  expect(bases.find(base => base.variable === 'OTHER_URL')?.authVariables).toEqual([]);
});

it('never extends an explicit credential binding to a different origin inferred from variable names', () => {
  const env = { DATA_URL: 'https://unrelated.example.invalid', ORIGINAL_URL: 'https://configured.example.invalid/api', DATA_TOKEN: 'fixture-private-value' };
  const bases = importedHttpBases({ version: 1, env, credentials: [], mcp: [{ name: 'data', url: 'https://configured.example.invalid/mcp', headers: { Authorization: `Bearer ${env.DATA_TOKEN}` } }] }, new Set(Object.keys(env)));
  expect(bases.find(base => base.variable === 'DATA_URL')?.authVariables).toEqual([]);
  expect(bases.find(base => base.variable === 'ORIGINAL_URL')?.authVariables).toEqual(['DATA_TOKEN']);
});

it('supports a single default API origin and same-origin aliases without admitting invalid URLs', () => {
  const env = { BASE_URL: 'https://api.example.invalid/v1', API_URL: 'https://api.example.invalid/v2', API_KEY: 'fixture-api-key', DATA_URL: 'file:///private', BAD_URL: 'https://user:password@example.invalid' };
  const bases = importedHttpBases({ version: 1, env, mcp: [], credentials: [] }, new Set(Object.keys(env)));
  expect(bases.map(base => base.variable)).toEqual(['BASE_URL', 'API_URL']);
  expect(bases.every(base => base.authVariables.includes('API_KEY'))).toBe(true);
});
