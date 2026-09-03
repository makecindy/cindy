/**
 * PrRefsContext 按 PR 键共享状态:本机与 device-link 查询会写同一格。
 * shouldApplyPrStatus 决定谁留下。
 */
import { describe, expect, it } from 'vitest';

import { shouldApplyPrStatus } from '../lib/prStatus';

const ok = { ok: true as const };
const missing = { ok: false as const, reason: 'gh-missing' };
const notLoggedIn = { ok: false as const, reason: 'gh-not-logged-in' };
const noToken = { ok: false as const, reason: 'no-token' };
const fetchFailed = { ok: false as const, reason: 'fetch-failed' };
const notFound = { ok: false as const, reason: 'not-found' };

describe('shouldApplyPrStatus', () => {
  it('空槽总是写入', () => {
    expect(shouldApplyPrStatus(undefined, missing)).toBe(true);
    expect(shouldApplyPrStatus(undefined, ok)).toBe(true);
  });

  it('失败不得覆盖成功', () => {
    expect(shouldApplyPrStatus(ok, missing)).toBe(false);
    expect(shouldApplyPrStatus(ok, noToken)).toBe(false);
  });

  it('远端 no-token / fetch-failed / not-found 不得覆盖本机可操作失败', () => {
    expect(shouldApplyPrStatus(missing, noToken)).toBe(false);
    expect(shouldApplyPrStatus(notLoggedIn, noToken)).toBe(false);
    expect(shouldApplyPrStatus(missing, fetchFailed)).toBe(false);
    expect(shouldApplyPrStatus(missing, notFound)).toBe(false);
  });

  it('本机可操作失败与成功都可以覆盖不可操作失败(轮询恢复引导)', () => {
    expect(shouldApplyPrStatus(noToken, missing)).toBe(true);
    expect(shouldApplyPrStatus(noToken, notLoggedIn)).toBe(true);
    expect(shouldApplyPrStatus(noToken, ok)).toBe(true);
    expect(shouldApplyPrStatus(fetchFailed, missing)).toBe(true);
  });

  it('可操作失败之间、成功覆盖失败都允许', () => {
    expect(shouldApplyPrStatus(missing, notLoggedIn)).toBe(true);
    expect(shouldApplyPrStatus(missing, ok)).toBe(true);
  });
});
