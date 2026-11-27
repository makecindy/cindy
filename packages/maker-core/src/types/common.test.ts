import { describe, expect, it } from 'vitest';
import {
  ALL_ENGINE_KINDS,
  BUILTIN_AGENT_KINDS_LIST,
  assertNeverEngineKind,
  isAcpEngineKind,
  isBuiltinAgentKind,
  isEngineKind,
  matchEngineKind,
  type EngineKind,
} from './common.js';

describe('EngineKind and AgentKind type guards & exhaustive dispatch', () => {
  it('distinguishes built-in AgentKind from all four EngineKind values', () => {
    expect(BUILTIN_AGENT_KINDS_LIST).toEqual(['claude-code', 'codex', 'pi']);
    expect(ALL_ENGINE_KINDS).toEqual(['claude-code', 'codex', 'pi', 'acp']);

    for (const kind of BUILTIN_AGENT_KINDS_LIST) {
      expect(isBuiltinAgentKind(kind)).toBe(true);
      expect(isEngineKind(kind)).toBe(true);
      expect(isAcpEngineKind(kind)).toBe(false);
    }

    expect(isBuiltinAgentKind('acp')).toBe(false);
    expect(isEngineKind('acp')).toBe(true);
    expect(isAcpEngineKind('acp')).toBe(true);

    for (const invalid of ['cc', 'unknown', '', null, undefined, 42]) {
      expect(isBuiltinAgentKind(invalid)).toBe(false);
      expect(isEngineKind(invalid)).toBe(false);
      expect(isAcpEngineKind(invalid)).toBe(false);
    }
  });

  it('dispatches every EngineKind exhaustively without falling back acp to claude-code', () => {
    const labelFor = (kind: EngineKind): string =>
      matchEngineKind(kind, {
        'claude-code': () => 'Claude Code',
        codex: () => 'Codex',
        pi: () => 'Pi',
        acp: () => 'ACP Plugin Engine',
      });

    expect(ALL_ENGINE_KINDS.map(labelFor)).toEqual([
      'Claude Code',
      'Codex',
      'Pi',
      'ACP Plugin Engine',
    ]);
  });

  it('throws a clear error from assertNeverEngineKind on unexpected runtime values', () => {
    expect(() => assertNeverEngineKind('mystery' as never, 'test-dispatch')).toThrow(
      'Unhandled EngineKind (test-dispatch): mystery',
    );
  });
});
