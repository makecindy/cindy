import { describe, expect, it } from 'vitest';
import {
  resolveSendScopeReason,
  sendScopeReasonI18nKey,
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

  // #10906 review P1:用户看得见的文案走 i18n key(渲染层对未登记的码只能回落原文),
  // 且没有附件确认的发送不能说「附件确认」。中止与其余作用域失效是两个 key。
  it('maps every reason to a localized message key without blaming an attachment', () => {
    const reasons = [
      'aborted', 'boundary-pending', 'owner-unset', 'owner-changed', 'generation-changed',
      'sender-destroyed', 'frame-missing', 'frame-detached', 'frame-changed', 'window-missing', 'window-destroyed',
    ] as const;
    for (const reason of reasons) {
      expect(sendScopeReasonI18nKey(reason)).toMatch(/^deviceLinkSendScope\./);
    }
    expect(sendScopeReasonI18nKey('aborted')).toBe('deviceLinkSendScope.cancelled');
    for (const reason of ['owner-changed', 'window-destroyed'] as const) {
      expect(sendScopeReasonI18nKey(reason)).toBe('deviceLinkSendScope.invalid');
    }
  });
});
