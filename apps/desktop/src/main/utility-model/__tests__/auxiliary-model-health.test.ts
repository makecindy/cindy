import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 测试价值
 * - 被测生产入口：真实 one-shot 结果的模型级失败记录器。
 * - 用户可观察结果：临时失败累计后隔离，连接恢复后解除隔离。
 * - 现有覆盖缺口：one-shot 请求测试覆盖单次 HTTP 失败，但没有覆盖跨请求窗口。
 * - 最小失败输入与 tier：同一模型三次 request_failed 触发提醒，五次才隔离，unit。
 */
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test',
  isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'test', ownerGeneration: 1 }),
}));

import {
  __testing,
  getAuxiliaryModelHealthSnapshot,
  isAuxiliaryModelTemporarilyUnavailable,
  recordAuxiliaryModelResult,
} from '../auxiliary-model-health.js';
import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';

const failed = (reason: 'request_failed' | 'http_error' = 'request_failed'): UtilityTextResult => ({
  ok: false,
  reason: 'all_candidates_failed',
  attempts: [reason === 'http_error'
    ? {
        providerId: 'provider', model: 'model', transport: 'litellm-chat-completions',
        status: 'failed', reason: 'http_error', httpStatus: 403,
      }
    : {
        providerId: 'provider', model: 'model', transport: 'litellm-chat-completions',
        status: 'failed', reason: 'request_failed',
      }],
});

describe('auxiliary model health', () => {
  beforeEach(() => __testing.reset());

  it('warns after three transient failures, isolates after five, and recovers on success', () => {
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
    recordAuxiliaryModelResult(failed());
    recordAuxiliaryModelResult(failed());
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
    recordAuxiliaryModelResult(failed());
    expect(getAuxiliaryModelHealthSnapshot()[0]?.status).toBe('warning');
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
    recordAuxiliaryModelResult(failed());
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
    recordAuxiliaryModelResult(failed());
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(true);

    recordAuxiliaryModelResult({
      ok: true,
      text: 'title',
      providerId: 'provider',
      model: 'model',
      transport: 'litellm-chat-completions',
    });
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
  });

  it('counts only failures among the last ten actual attempts, even on different days', () => {
    vi.useFakeTimers();
    try {
      const success = () => recordAuxiliaryModelResult({
        ok: true, providerId: 'provider', model: 'model', text: 'title', transport: 'litellm-chat-completions',
      });
      for (let i = 0; i < 7; i++) success();
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(86_400_000);
        recordAuxiliaryModelResult(failed());
      }
      expect(getAuxiliaryModelHealthSnapshot()[0]).toMatchObject({ status: 'warning', failureCount: 3, attemptCount: 10 });
      success();
      recordAuxiliaryModelResult(failed());
      expect(getAuxiliaryModelHealthSnapshot()[0].status).toBe('warning');
      recordAuxiliaryModelResult(failed());
      expect(getAuxiliaryModelHealthSnapshot()[0]).toMatchObject({ status: 'isolated', failureRate: 0.5 });
    } finally { vi.useRealTimers(); }
  });

  it('isolates deterministic authorization failures immediately', () => {
    recordAuxiliaryModelResult(failed('http_error'));
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(true);
  });

  it('does not isolate a single ordinary 400 or 422 contract failure', () => {
    for (const status of [400, 422]) {
      __testing.reset();
      recordAuxiliaryModelResult({
        ok: false,
        reason: 'all_candidates_failed',
        attempts: [{
          providerId: 'provider',
          model: 'model',
          transport: 'litellm-chat-completions',
          status: 'failed',
          reason: 'http_error',
          httpStatus: status,
        }],
      });
      expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(false);
    }
  });

  it('isolates an explicit model-unavailable classification immediately', () => {
    recordAuxiliaryModelResult({
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: 'provider',
        model: 'model',
        transport: 'litellm-chat-completions',
        status: 'failed',
        reason: 'model_unavailable',
      }],
    });
    expect(isAuxiliaryModelTemporarilyUnavailable('provider', 'model')).toBe(true);
  });
});
