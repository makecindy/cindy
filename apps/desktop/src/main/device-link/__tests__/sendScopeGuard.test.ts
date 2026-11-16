import { describe, expect, it } from 'vitest';
import {
  describeSendScopeReason,
  resolveSendScopeReason,
  type SendScopeProbe,
} from '../sendScopeGuard';

// #10852 P1: 守卫命中的是哪一条要能反推,文案也不能在没有附件确认时提「附件确认」。
const VALID: SendScopeProbe = {
  aborted: false,
  boundaryPending: false,
  ownerDataOwnerId: 'owner-x',
  ownerGeneration: 1,
  currentDataOwnerId: 'owner-x',
  currentGeneration: 1,
  senderDestroyed: false,
  frameMissing: false,
  frameDetached: false,
  frameIsMainFrame: true,
  windowMissing: false,
  windowDestroyed: false,
};

describe('send scope guard', () => {
  it('accepts a scope that is still current', () => {
    expect(resolveSendScopeReason(VALID)).toBeNull();
  });

  it('names the condition that fired', () => {
    expect(resolveSendScopeReason({ ...VALID, aborted: true })).toBe('aborted');
    expect(resolveSendScopeReason({ ...VALID, boundaryPending: true })).toBe('boundary-pending');
    expect(resolveSendScopeReason({ ...VALID, ownerDataOwnerId: null })).toBe('owner-unset');
    expect(resolveSendScopeReason({ ...VALID, currentDataOwnerId: 'owner-y' })).toBe('owner-changed');
    expect(resolveSendScopeReason({ ...VALID, currentGeneration: 2 })).toBe('generation-changed');
    expect(resolveSendScopeReason({ ...VALID, senderDestroyed: true })).toBe('sender-destroyed');
    expect(resolveSendScopeReason({ ...VALID, frameMissing: true })).toBe('frame-missing');
    expect(resolveSendScopeReason({ ...VALID, frameDetached: true })).toBe('frame-detached');
    expect(resolveSendScopeReason({ ...VALID, frameIsMainFrame: false })).toBe('frame-changed');
    expect(resolveSendScopeReason({ ...VALID, windowMissing: true })).toBe('window-missing');
    expect(resolveSendScopeReason({ ...VALID, windowDestroyed: true })).toBe('window-destroyed');
  });

  it('reports the first condition that fired', () => {
    // 取消信号最先命中:其余条件多为它的下游结果,报成别的会误导排查。
    expect(resolveSendScopeReason({
      ...VALID,
      aborted: true,
      boundaryPending: true,
      currentDataOwnerId: 'owner-y',
      senderDestroyed: true,
    })).toBe('aborted');
  });

  it('does not blame an attachment confirmation on sends that never had one', () => {
    for (const reason of ['aborted', 'owner-changed', 'window-destroyed'] as const) {
      expect(describeSendScopeReason(reason)).not.toMatch(/attachment/i);
    }
    expect(describeSendScopeReason('aborted')).toMatch(/cancelled/i);
  });
});
