import { describe, expect, it } from 'vitest';
import {
  dispatchCredentialSwitchOutcome,
  subscribeCredentialSwitchOutcome,
} from '@/session/credentialSwitchOutcome';

describe('credential switch outcome pushes', () => {
  it('delivers only typed outcomes with the owning device and session', () => {
    const received: unknown[] = [];
    const off = subscribeCredentialSwitchOutcome((outcome) => received.push(outcome));
    try {
      dispatchCredentialSwitchOutcome('device-a', 'maker:session-credential-switch-failed', {
        sessionId: 'session-a', reason: 'apply-failed', error: 'internal secret must not surface',
      });
      dispatchCredentialSwitchOutcome('device-b', 'maker:session-credential-switch-applied', {
        sessionId: 'session-b', model: 'model', providerId: null,
      });
      dispatchCredentialSwitchOutcome('device-a', 'maker:session-credential-switch-failed', {
        sessionId: 'session-a', reason: 'unknown',
      });
      dispatchCredentialSwitchOutcome('device-a', 'maker:session-credential-switch-applied', { sessionId: '' });
      expect(received).toEqual([
        { deviceId: 'device-a', sessionId: 'session-a', kind: 'failed', reason: 'apply-failed' },
        { deviceId: 'device-b', sessionId: 'session-b', kind: 'applied' },
      ]);
    } finally {
      off();
    }
    dispatchCredentialSwitchOutcome('device-a', 'maker:session-credential-switch-applied', { sessionId: 'session-a' });
    expect(received).toHaveLength(2);
  });
});
