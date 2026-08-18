import { describe, expect, it } from 'vitest';

import { isDbAgentKind, isMakerAgentKindWire } from '../agentKindConversion';

describe('agent kind runtime guards', () => {
  it.each(['cc', 'codex', 'pi', 'dsh'] as const)('accepts %s for persisted sessions', (kind) => {
    expect(isDbAgentKind(kind)).toBe(true);
  });

  it.each(['claude-code', 'codex', 'pi', 'dsh'] as const)('accepts %s for Maker IPC', (kind) => {
    expect(isMakerAgentKindWire(kind)).toBe(true);
  });

  it('keeps the two wire vocabularies distinct', () => {
    expect(isDbAgentKind('claude-code')).toBe(false);
    expect(isMakerAgentKindWire('cc')).toBe(false);
    expect(isDbAgentKind('unknown')).toBe(false);
    expect(isMakerAgentKindWire('unknown')).toBe(false);
  });
});
