import { describe, expect, it } from 'vitest';
import {
  ALL_DB_ENGINE_KINDS,
  ALL_MAKER_ENGINE_KINDS,
  dbToMakerEngineKind,
  isDbEngineKind,
  isMakerEngineKind,
  isPluginEngineKind,
  makerToDbEngineKind,
  matchDbEngineKind,
  matchMakerEngineKind,
  type DbEngineKind,
  type MakerEngineKindWire,
} from '../agentKindConversion.js';
import { issueHarnessForAgentKind, parseIssueHarness } from '../issueRuntimeMetadata.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineModelDisabled,
  pluginEngineKeyFromProviderId,
  pluginEngineProviderId,
} from '../pluginEngines.js';

describe('EngineKind conversion and ACP identity retention contract', () => {
  it('round-trips every DbEngineKind and MakerEngineKindWire without dropping acp to Claude', () => {
    const pairs: Array<[DbEngineKind, MakerEngineKindWire]> = [
      ['cc', 'claude-code'],
      ['codex', 'codex'],
      ['pi', 'pi'],
      ['acp', 'acp'],
    ];

    expect(ALL_DB_ENGINE_KINDS).toEqual(pairs.map(([db]) => db));
    expect(ALL_MAKER_ENGINE_KINDS).toEqual(pairs.map(([, maker]) => maker));

    for (const [db, maker] of pairs) {
      expect(isDbEngineKind(db)).toBe(true);
      expect(isMakerEngineKind(maker)).toBe(true);
      expect(dbToMakerEngineKind(db)).toBe(maker);
      expect(makerToDbEngineKind(maker)).toBe(db);
      expect(isPluginEngineKind(db)).toBe(db === 'acp');
      expect(isPluginEngineKind(maker)).toBe(maker === 'acp');
    }

    expect(isDbEngineKind('claude-code')).toBe(false);
    expect(isMakerEngineKind('cc')).toBe(false);
  });

  it('dispatches all four DB and maker engine kinds exhaustively', () => {
    const dbLabels = ALL_DB_ENGINE_KINDS.map((kind) =>
      matchDbEngineKind(kind, {
        cc: () => 'db:cc',
        codex: () => 'db:codex',
        pi: () => 'db:pi',
        acp: () => 'db:acp',
      }),
    );
    expect(dbLabels).toEqual(['db:cc', 'db:codex', 'db:pi', 'db:acp']);

    const makerLabels = ALL_MAKER_ENGINE_KINDS.map((kind) =>
      matchMakerEngineKind(kind, {
        'claude-code': () => 'maker:claude',
        codex: () => 'maker:codex',
        pi: () => 'maker:pi',
        acp: () => 'maker:acp',
      }),
    );
    expect(makerLabels).toEqual(['maker:claude', 'maker:codex', 'maker:pi', 'maker:acp']);
  });

  it('preserves ACP identity in issue metadata and plugin provider IDs (including multi-account suffix)', () => {
    expect(issueHarnessForAgentKind('acp')).toBe('ACP');
    expect(parseIssueHarness('ACP')).toBe('ACP');
    expect(ALL_MAKER_ENGINE_KINDS.map(issueHarnessForAgentKind)).toEqual([
      'Claude Code',
      'Codex',
      'Pi',
      'ACP',
    ]);

    const baseKey = 'cindy-antigravity-acp:antigravity';
    const baseProvider = pluginEngineProviderId(baseKey);
    expect(baseProvider).toBe('acp-plugin:cindy-antigravity-acp:antigravity');
    expect(pluginEngineKeyFromProviderId(baseProvider)).toBe(baseKey);

    const accountProvider = `${baseProvider}~a1b2c3d4`;
    expect(pluginEngineKeyFromProviderId(accountProvider)).toBe(`${baseKey}~a1b2c3d4`);
    expect(pluginEngineKeyFromProviderId('anthropic')).toBeNull();
    expect(pluginEngineKeyFromProviderId('acp-plugin:broken')).toBeNull();
  });

  it('blocks default model fallback whenever any model of a plugin engine is disabled', () => {
    expect(isPluginEngineModelDisabled(PLUGIN_ENGINE_DEFAULT_MODEL, undefined)).toBe(false);
    expect(isPluginEngineModelDisabled(PLUGIN_ENGINE_DEFAULT_MODEL, [])).toBe(false);
    expect(isPluginEngineModelDisabled(PLUGIN_ENGINE_DEFAULT_MODEL, ['gemini-pro'])).toBe(true);
    expect(isPluginEngineModelDisabled('gemini-pro', ['gemini-pro'])).toBe(true);
    expect(isPluginEngineModelDisabled('gemini-flash', ['gemini-pro'])).toBe(false);
  });
});
