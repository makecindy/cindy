import { describe, expect, it } from 'vitest';
import { dbToMakerAgentKind, makerToDbAgentKind, normalizeDbAgentKind } from '../agentKindConversion';

describe('Cursor native identity', () => {
  it('round trips without falling back to Claude', () => {
    expect(dbToMakerAgentKind('cursor')).toBe('cursor');
    expect(makerToDbAgentKind('cursor')).toBe('cursor');
    expect(normalizeDbAgentKind('cursor')).toBe('cursor');
  });
  it('preserves historical defaults for unknown values', () => {
    expect(dbToMakerAgentKind(undefined)).toBe('claude-code');
    expect(normalizeDbAgentKind('unknown')).toBe('cc');
  });
});
