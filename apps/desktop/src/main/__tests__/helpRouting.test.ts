import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import { buildRouterPrompt, parseRouterOutput } from '../maker-ipc/help';
import { HELP_KNOWLEDGE } from '../maker-ipc/helpKnowledge.generated';
import type { HelpMessage } from '../../shared/helpTypes';

const KNOWN = new Set(HELP_KNOWLEDGE.map((d) => d.id));

describe('parseRouterOutput', () => {
  it('keeps known ids from a comma-separated list', () => {
    expect(parseRouterOutput('providers, integrations', KNOWN)).toEqual(['providers', 'integrations']);
  });

  it('filters out unknown ids', () => {
    expect(parseRouterOutput('providers, totally-made-up', KNOWN)).toEqual(['providers']);
  });

  it('returns [] for NONE (case-insensitive) and for empty', () => {
    expect(parseRouterOutput('NONE', KNOWN)).toEqual([]);
    expect(parseRouterOutput('none', KNOWN)).toEqual([]);
    expect(parseRouterOutput('   \n ', KNOWN)).toEqual([]);
  });

  it('caps at 2 ids', () => {
    expect(parseRouterOutput('providers, integrations, voice-input', KNOWN)).toHaveLength(2);
  });

  it('dedupes and tolerates whitespace, newlines and case', () => {
    expect(parseRouterOutput('  PROVIDERS\n providers ', KNOWN)).toEqual(['providers']);
  });
});

describe('buildRouterPrompt', () => {
  it('lists every topic id and includes the conversation', () => {
    const history: HelpMessage[] = [{ role: 'user', content: 'how do I connect slack?' }];
    const p = buildRouterPrompt(history);
    for (const d of HELP_KNOWLEDGE) expect(p).toContain(d.id);
    expect(p).toContain('USER: how do I connect slack?');
  });
});

describe('HELP_KNOWLEDGE invariants', () => {
  // Mirror of ALLOWED_TABS in maker-ipc/help.ts (and HelpTabId in
  // shared/helpTypes.ts). Keep in sync when the deep-link whitelist changes.
  const ALLOWED = new Set([
    'general',
    'personalization',
    'api-keys',
    'providers',
    'voice-input',
    'import',
    'connections',
    'im-bot',
    'about',
    'ghosts',
    'remote-control',
  ]);

  it('is non-empty', () => {
    expect(HELP_KNOWLEDGE.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = HELP_KNOWLEDGE.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-empty title/summary/content and only whitelisted (or omitted) tabs', () => {
    for (const d of HELP_KNOWLEDGE) {
      expect(d.title.trim().length).toBeGreaterThan(0);
      expect(d.summary.trim().length).toBeGreaterThan(0);
      expect(d.content.trim().length).toBeGreaterThan(0);
      if (d.tab !== undefined) expect(ALLOWED.has(d.tab)).toBe(true);
    }
  });

  it('Cindy AI guidance stays under providers; retired api-keys doc is gone', () => {
    const providers = HELP_KNOWLEDGE.find((d) => d.id === 'providers');

    expect(providers?.tab).toBe('providers');
    expect(providers?.title).toContain('Cindy AI');
    expect(providers?.summary).toContain('Model Providers');

    // 「工具密钥」(api-keys) 面板已于 2026-07-13 下架:Mivo / 搜索 key 改由
    // 对应意识详情页收单,帮助文档随面板一并退役。
    expect(HELP_KNOWLEDGE.find((d) => d.id === 'api-keys')).toBeUndefined();
  });
});
