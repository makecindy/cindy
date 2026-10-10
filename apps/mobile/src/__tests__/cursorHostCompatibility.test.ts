import { describe, expect, it } from 'vitest';
import { availableNewSessionAgentOptions, DEFAULT_NEW_SESSION_DRAFT, withAgentDefaults, buildRemoteCreateSessionOptions } from '../session/newSession';
import { normalizeSessionAgentSwitchIntent, sessionAgentKind, mobileAgentLabel } from '../session/sessionAgentSwitch';

describe('Cursor host compatibility', () => {
  it('requires a confirmed host runtime before offering Cursor creation', () => {
    expect(availableNewSessionAgentOptions(null).some((option) => option.kind === 'cursor')).toBe(false);
    expect(availableNewSessionAgentOptions(new Set(['claude-code', 'codex', 'pi'])).some((option) => option.kind === 'cursor')).toBe(false);
    expect(availableNewSessionAgentOptions(new Set(['cursor']))).toEqual([{ kind: 'cursor', label: 'Cursor' }]);
  });
  it('normalizes new and restored native selections before sending to the host', () => {
    const draft = withAgentDefaults(DEFAULT_NEW_SESSION_DRAFT, 'cursor');
    expect(draft.permissionMode).toBe('ask');
    const restored = { ...draft, model: 'account-model', providerId: 'cursor', permissionMode: 'auto', effort: 'medium', fastMode: true };
    const options = buildRemoteCreateSessionOptions(restored);
    expect(options).toMatchObject({ agentKind: 'cursor', model: 'account-model', providerId: 'cursor', permissionMode: 'auto', fastMode: true, effort: 'medium' });
    expect(withAgentDefaults(restored, 'cursor').fastMode).toBe(true);
    expect(withAgentDefaults(restored, 'cursor').permissionMode).toBe('auto');
  });
  it('preserves the native identity in persisted sessions and switching intents', () => {
    expect(sessionAgentKind({ agentKind: 'cursor' })).toBe('cursor');
    expect(mobileAgentLabel('cursor')).toBe('Cursor');
    expect(normalizeSessionAgentSwitchIntent({ targetAgentKind: 'cursor', model: 'native-model', providerId: 'cursor' }))
      .toMatchObject({ targetAgentKind: 'cursor', model: 'native-model', providerId: 'cursor' });
  });
});
