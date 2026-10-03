import { describe, expect, it } from 'vitest';
import {
  isCodexFollowUpMode,
  resolveCodexFollowUpMode,
  shouldAutoSteerCodex,
} from '../../../shared/codexFollowUp';
describe('Codex follow-up settings', () => {
  it('inherits dynamically and keeps an explicit queue override', () => {
    expect(resolveCodexFollowUpMode('queue', null)).toBe('queue');
    expect(resolveCodexFollowUpMode('steer', null)).toBe('steer');
    expect(resolveCodexFollowUpMode('steer', 'queue')).toBe('queue');
    expect(resolveCodexFollowUpMode('queue', 'steer')).toBe('steer');
  });
  it.each(['queue', 'steer'])('accepts %s', (value) =>
    expect(isCodexFollowUpMode(value)).toBe(true),
  );
  it.each([null, undefined, 'auto', {}, 1])('rejects invalid modes', (value) =>
    expect(isCodexFollowUpMode(value)).toBe(false),
  );
  const ordinary = { mode: 'steer' as const, agentKind: 'codex', source: 'desktop' };
  it('only steers an ordinary Codex composer send', () => {
    expect(shouldAutoSteerCodex(ordinary)).toBe(true);
    for (const patch of [
      { mode: 'queue' as const },
      { agentKind: 'claude-code' },
      { agentKind: 'pi' },
      { source: 'bot' },
      { source: 'review' },
      { source: 'telegram' },
      { orcaRole: 'lead' },
      { origin: { kind: 'session' } },
      { synthetic: 'continue' },
      { automatic: true },
    ]) {
      expect(shouldAutoSteerCodex({ ...ordinary, ...patch })).toBe(false);
    }
  });
});
