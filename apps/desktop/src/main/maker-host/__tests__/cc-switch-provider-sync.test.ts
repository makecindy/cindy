import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCcSwitchProviderRows,
  readCcSwitchProviderCandidates,
} from '../cc-switch-provider-sync.js';

const tempDirectories: string[] = [];

function tempDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cindy-cc-switch-sync-'));
  tempDirectories.push(directory);
  return path.join(directory, 'cc-switch.db');
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('parseCcSwitchProviderRows', () => {
  it('maps Claude, Codex and Pi rows to stable Cindy custom providers', () => {
    const result = parseCcSwitchProviderRows([
      {
        id: 'claude-1',
        app_type: 'claude',
        name: 'Claude Relay',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://claude.example/v1/',
            ANTHROPIC_AUTH_TOKEN: 'sk-claude-test',
            ANTHROPIC_MODEL: 'claude-test',
          },
        }),
        meta: '{}',
      },
      {
        id: 'codex-1',
        app_type: 'codex',
        name: 'Codex Relay',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-codex-test' },
          config: [
            'model_provider = "relay"',
            'model = "gpt-test"',
            '',
            '[model_providers.relay]',
            'base_url = "https://codex.example/v1"',
            'wire_api = "responses"',
          ].join('\n'),
        }),
        meta: '{}',
      },
      {
        id: 'pi-1',
        app_type: 'pi',
        name: 'Pi Relay',
        settings_config: JSON.stringify({
          baseUrl: 'https://pi.example/v1',
          apiKey: 'sk-pi-test',
          api: 'openai-completions',
          models: [{ id: 'pi-test', name: 'Pi Test' }],
        }),
        meta: '{}',
      },
    ]);

    expect(result.skippedCount).toBe(0);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((candidate) => candidate.agent)).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
    expect(result.candidates[0]?.config.runtimes['claude-code']?.baseUrl).toBe(
      'https://claude.example/v1',
    );
    expect(result.candidates[1]?.config.runtimes.codex?.wireProtocol).toBe('openai-responses');
    expect(result.candidates[2]?.config.runtimes.pi?.models[0]?.piApi).toBe('openai-completions');
    expect(result.candidates[0]?.keys['claude-code']).toBe('sk-claude-test');
  });

  it('skips managed OAuth and invalid public endpoints without leaking headers', () => {
    const result = parseCcSwitchProviderRows([
      {
        id: 'oauth',
        app_type: 'claude',
        name: 'OAuth',
        settings_config: JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://oauth.example/v1', ANTHROPIC_AUTH_TOKEN: 'token' },
          auth: { auth_mode: 'chatgpt' },
        }),
        meta: '{}',
      },
      {
        id: 'bad',
        app_type: 'codex',
        name: 'Bad',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-test' },
          config: [
            'model_provider = "relay"',
            '[model_providers.relay]',
            'base_url = "file:///tmp/not-http"',
            'wire_api = "responses"',
            'http_headers = { Authorization = "Bearer should-not-leak" }',
          ].join('\n'),
        }),
        meta: '{}',
      },
    ]);

    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });

  it('bounds malformed rows and ignores unsupported applications', () => {
    const result = parseCcSwitchProviderRows([
      {
        id: 'unsupported',
        app_type: 'gemini',
        name: 'Gemini',
        settings_config: '{}',
        meta: '{}',
      },
      {
        id: 'broken',
        app_type: 'claude',
        name: 'Broken',
        settings_config: '{not-json',
        meta: '{}',
      },
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.skippedCount).toBe(2);
  });

  it('rejects URLs carrying query or fragment data', () => {
    const result = parseCcSwitchProviderRows([
      {
        id: 'query-secret',
        app_type: 'claude',
        name: 'Query secret',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://api.example.test/v1?api_key=secret',
            ANTHROPIC_AUTH_TOKEN: 'fixture-key',
          },
        }),
        meta: '{}',
      },
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.skippedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('readCcSwitchProviderCandidates', () => {
  it('reads the supported CC Switch schema without mutating source rows', () => {
    const dbPath = tempDatabasePath();
    const db = new Database(dbPath);
    db.exec(
      [
        'CREATE TABLE providers (',
        'id TEXT NOT NULL,',
        'app_type TEXT NOT NULL,',
        'name TEXT NOT NULL,',
        "settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',",
        'provider_type TEXT, sort_index INTEGER, created_at INTEGER,',
        'PRIMARY KEY (id, app_type))',
      ].join('\n'),
    );
    const settings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://fixture.example/v1',
        ANTHROPIC_AUTH_TOKEN: 'fixture-key',
        ANTHROPIC_MODEL: 'fixture-model',
      },
    });
    db.prepare(
      [
        'INSERT INTO providers',
        '(id, app_type, name, settings_config, meta, provider_type, sort_index, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' '),
    ).run('fixture', 'claude', 'Fixture', settings, '{}', null, 1, 1);
    db.close();

    const result = readCcSwitchProviderCandidates(dbPath);
    expect(result).toMatchObject({ skippedCount: 0 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceApp: 'claude',
      agent: 'claude-code',
      config: { name: 'Fixture' },
    });

    const source = new Database(dbPath, { readonly: true });
    expect(
      source.prepare('SELECT settings_config FROM providers WHERE id = ?').pluck().get('fixture'),
    ).toBe(settings);
    source.close();
  });

  it('fails closed for missing or unsupported databases', () => {
    const missingDirectory = mkdtempSync(path.join(tmpdir(), 'cindy-cc-switch-missing-'));
    tempDirectories.push(missingDirectory);
    expect(() =>
      readCcSwitchProviderCandidates(path.join(missingDirectory, 'missing.db')),
    ).toThrow();

    const unsupportedPath = tempDatabasePath();
    const unsupported = new Database(unsupportedPath);
    unsupported.exec('CREATE TABLE providers (id TEXT PRIMARY KEY)');
    unsupported.close();
    expect(() => readCcSwitchProviderCandidates(unsupportedPath)).toThrow(
      'unsupported CC Switch provider database schema',
    );

    const damagedPath = tempDatabasePath();
    const damaged = new Database(damagedPath);
    damaged.exec('CREATE TABLE unrelated (id TEXT)');
    damaged.close();
    expect(() => readCcSwitchProviderCandidates(damagedPath)).toThrow(
      'unsupported CC Switch provider database schema',
    );
  });

  it('reads an older schema without optional provenance and ordering columns', () => {
    const dbPath = tempDatabasePath();
    const db = new Database(dbPath);
    db.exec(
      [
        'CREATE TABLE providers (',
        'id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,',
        "settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',",
        'PRIMARY KEY (id, app_type))',
      ].join('\n'),
    );
    db.prepare(
      'INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'legacy',
      'claude',
      'Legacy',
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://legacy.example/v1',
          ANTHROPIC_AUTH_TOKEN: 'fixture-key',
        },
      }),
      '{}',
    );
    db.close();

    expect(readCcSwitchProviderCandidates(dbPath).candidates).toHaveLength(1);
  });
});
