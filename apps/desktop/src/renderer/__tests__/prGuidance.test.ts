// @vitest-environment jsdom
/**
 * PR 徽标在本机 gh 缺失 / 未登录时的引导判定(prGuidanceFor / prFailureCopyKey)
 * 与输入框预填事件总线(insertPromptIntoComposer / subscribePromptInsert)。
 *
 * 不变量:只有 gh-missing / gh-not-logged-in 两种失败把点击变成引导动作;
 * 其余失败(no-token / not-found / fetch-failed)与成功态点击仍是打开 PR。
 */

import { describe, expect, it, vi } from 'vitest';

import { prFailureCopyKey, prGuidanceFor } from '../features/cc-agent/gitContextPrVisuals';
import { insertPromptIntoComposer, subscribePromptInsert } from '../lib/composerActionsBus';
import type { PrStatusFailureReason, PrStatusResult } from '../lib/gitContext.types';

const base = { owner: 'makecindy', repo: 'cindy', prNumber: 3821 };

function failed(reason: PrStatusFailureReason): PrStatusResult {
  return { ok: false, ...base, reason };
}

const ok: PrStatusResult = {
  ok: true,
  ...base,
  status: 'open',
  title: 't',
  htmlUrl: 'https://github.com/makecindy/cindy/pull/3821',
  branch: 'fix/x',
  unresolvedCount: 0,
};

describe('prGuidanceFor', () => {
  it('gh 未安装 → install;gh 未登录 → login', () => {
    expect(prGuidanceFor(failed('gh-missing'))).toBe('install');
    expect(prGuidanceFor(failed('gh-not-logged-in'))).toBe('login');
  });

  it('用户做不了什么的失败、成功态与加载中都不引导(点击仍是打开 PR)', () => {
    for (const reason of ['no-token', 'not-found', 'fetch-failed'] as const) {
      expect(prGuidanceFor(failed(reason))).toBeNull();
    }
    expect(prGuidanceFor(ok)).toBeNull();
    expect(prGuidanceFor(undefined)).toBeNull();
  });
});

describe('prFailureCopyKey', () => {
  it('每种失败原因映射到独立文案 key;no-token / fetch-failed 共用 statusUnknown', () => {
    expect(prFailureCopyKey(failed('gh-missing'))).toBe('ccAgent.gitContext.pr.ghMissing');
    expect(prFailureCopyKey(failed('gh-not-logged-in'))).toBe(
      'ccAgent.gitContext.pr.ghNotLoggedIn',
    );
    expect(prFailureCopyKey(failed('not-found'))).toBe('ccAgent.gitContext.pr.notFound');
    expect(prFailureCopyKey(failed('no-token'))).toBe('ccAgent.gitContext.pr.statusUnknown');
    expect(prFailureCopyKey(failed('fetch-failed'))).toBe('ccAgent.gitContext.pr.statusUnknown');
  });

  it('成功态与加载中不给失败文案', () => {
    expect(prFailureCopyKey(ok)).toBeNull();
    expect(prFailureCopyKey(undefined)).toBeNull();
  });
});

describe('composerActionsBus prompt insert', () => {
  it('订阅方收到 targetSessionId + text;取消订阅后不再收到', () => {
    const handler = vi.fn();
    const unsubscribe = subscribePromptInsert(handler);
    insertPromptIntoComposer({ targetSessionId: 's1', text: 'gh auth login' });
    expect(handler).toHaveBeenCalledWith({ targetSessionId: 's1', text: 'gh auth login' });
    unsubscribe();
    insertPromptIntoComposer({ targetSessionId: 's1', text: 'again' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
