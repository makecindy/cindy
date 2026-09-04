// @vitest-environment jsdom
/**
 * PR 徽标在本机 gh 缺失 / 未登录时的引导判定(prGuidanceFor / prFailureCopyKey)
 * 与输入框预填事件总线(insertPromptIntoComposer / subscribePromptInsert)。
 *
 * 不变量:只有本机、可写输入框的任务上,gh-missing / gh-not-logged-in 才把点击变成引导;
 * SSH / device-link / review 只读与其余失败点击仍打开 PR。
 * 预填提示词在已有草稿时必须先 splitBlock,不得拼到最后一个字符后面。
 */

import { describe, expect, it, vi } from 'vitest';

import { prFailureCopyKey, prGuidanceFor } from '../features/cc-agent/gitContextPrVisuals';
import {
  hasPromptInsertSubscriber,
  insertPromptIntoComposer,
  insertPromptIntoEditor,
  subscribePromptInsert,
} from '../lib/composerActionsBus';
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

  it('点击无法兑现引导时退回打开 PR:远端 Agent 或只读输入框', () => {
    expect(prGuidanceFor(failed('gh-missing'), { remoteHostId: 'host-1' })).toBeNull();
    expect(prGuidanceFor(failed('gh-not-logged-in'), { remoteHostId: 'host-1' })).toBeNull();
    expect(prGuidanceFor(failed('gh-missing'), { deviceLinkDeviceId: 'dev-1' })).toBeNull();
    expect(prGuidanceFor(failed('gh-not-logged-in'), { deviceLinkDeviceId: 'dev-1' })).toBeNull();
    expect(prGuidanceFor(failed('gh-missing'), { readOnly: true })).toBeNull();
    expect(prGuidanceFor(failed('gh-not-logged-in'), { readOnly: true })).toBeNull();
    expect(prGuidanceFor(failed('gh-missing'), { remoteHostId: null, readOnly: false })).toBe(
      'install',
    );
    expect(prGuidanceFor(failed('gh-not-logged-in'), { deviceLinkDeviceId: undefined })).toBe(
      'login',
    );
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
    const handler = vi.fn(() => true);
    const unsubscribe = subscribePromptInsert('s1', handler);
    expect(insertPromptIntoComposer({ targetSessionId: 's1', text: 'gh auth login' })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ targetSessionId: 's1', text: 'gh auth login' });
    unsubscribe();
    expect(insertPromptIntoComposer({ targetSessionId: 's1', text: 'again' })).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('没人接住才退回打开 PR;有订阅但拒绝写入则保持引导、不改动作', () => {
    expect(hasPromptInsertSubscriber('s1')).toBe(false);
    expect(insertPromptIntoComposer({ targetSessionId: 's1', text: 'x' })).toBe(false);
    const reject = subscribePromptInsert('s1', () => false);
    expect(hasPromptInsertSubscriber('s1')).toBe(true);
    expect(insertPromptIntoComposer({ targetSessionId: 's1', text: 'x' })).toBe(false);
    reject();
    expect(hasPromptInsertSubscriber('s1')).toBe(false);
    const accept = subscribePromptInsert('s1', () => true);
    expect(insertPromptIntoComposer({ targetSessionId: 's1', text: 'x' })).toBe(true);
    accept();
  });

  it('空输入框直接 insertContent;已有草稿先 splitBlock 再插入,避免粘连', () => {
    function makeChain() {
      const chain = {
        focus: vi.fn(),
        splitBlock: vi.fn(),
        insertContent: vi.fn(),
        run: vi.fn(),
      };
      chain.focus.mockReturnValue(chain);
      chain.splitBlock.mockReturnValue(chain);
      chain.insertContent.mockReturnValue(chain);
      return chain;
    }

    const empty = makeChain();
    insertPromptIntoEditor(empty, { isEmpty: true, text: 'gh auth login' });
    expect(empty.splitBlock).not.toHaveBeenCalled();
    expect(empty.insertContent).toHaveBeenCalledWith('gh auth login');
    expect(empty.run).toHaveBeenCalledTimes(1);

    const occupied = makeChain();
    insertPromptIntoEditor(occupied, { isEmpty: false, text: 'gh auth login' });
    expect(occupied.splitBlock).toHaveBeenCalledTimes(1);
    expect(occupied.insertContent).toHaveBeenCalledWith('gh auth login');
    expect(occupied.run).toHaveBeenCalledTimes(1);
    expect(occupied.splitBlock.mock.invocationCallOrder[0]).toBeLessThan(
      occupied.insertContent.mock.invocationCallOrder[0],
    );
  });
});
