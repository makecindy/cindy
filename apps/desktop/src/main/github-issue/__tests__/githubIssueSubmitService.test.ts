/**
 * githubIssueSubmitService 单测 —— 确认门(cancelled/timeout 时 postIssue 零调用)、
 * 用户编辑版优先、env 块拼装与 fallback locale、clamp、错误映射。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitServiceDeps,
} from '../githubIssueSubmitService';
import type { IssueConfirmDecision, IssueSubmissionIdentity } from '../issueConfirmBridge';

const REQ = {
  sessionId: 'sess-1',
  workingDir: '/repo',
  title: 'agent 整理的标题标题标题',
  body: '## 现象\nagent 整理的正文,长度足够覆盖最小要求。',
  type: 'bug' as const,
};
const PLATFORM_IDENTITY = { kind: 'platform', login: 'cindy-issue' } as const;

function makeDeps(over: Partial<GithubIssueSubmitServiceDeps> = {}) {
  const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(
    async (): Promise<IssueConfirmDecision> => ({
      confirmed: true,
      title: REQ.title,
      body: REQ.body,
      type: REQ.type,
      publicName: 'Carol',
      uiLanguage: 'zh-CN',
    }),
  );
  const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(async () => ({
    githubIssue: { number: 80, url: 'https://github.com/makecindy/cindy/issues/80' },
  }));
  const deps: GithubIssueSubmitServiceDeps = {
    confirm,
    resolveSubmissionIdentity: async () => PLATFORM_IDENTITY,
    postIssue,
    getAppVersion: () => '0.0.112',
    getOsInfo: () => ({ platform: 'darwin', arch: 'arm64', osVersion: '25.5.0' }),
    getRegion: () => 'cn',
    getFallbackLocale: () => 'en',
    getSubmitterName: () => 'Carol',
    ...over,
  };
  return { deps, confirm, postIssue };
}

describe('submitGithubIssueWithConfirm', () => {
  it('确认门: cancelled / timeout 时 postIssue 零调用', async () => {
    for (const [reason, errorCode] of [
      ['cancelled', 'USER_CANCELLED'],
      ['timeout', 'CONFIRM_TIMEOUT'],
      ['session_aborted', 'USER_CANCELLED'],
      ['session_closed', 'USER_CANCELLED'],
    ] as const) {
      const { deps, postIssue } = makeDeps({
        confirm: vi.fn(async () => ({ confirmed: false as const, reason })),
      });
      const res = await submitGithubIssueWithConfirm(deps, REQ);
      expect(res).toMatchObject({ ok: false, errorCode });
      expect(postIssue).not.toHaveBeenCalled();
    }
  });

  it('confirm 收到 agent 草稿 + env;confirmed 后 postIssue 收到用户编辑版', async () => {
    const confirm = vi.fn(async (): Promise<IssueConfirmDecision> => ({
      confirmed: true,
      title: '用户改过的标题',
      body: '用户改过的正文',
      type: 'feature',
      publicName: '公开昵称',
      uiLanguage: 'ja',
    }));
    const { deps, postIssue } = makeDeps({ confirm });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(confirm).toHaveBeenCalledWith(
      'sess-1',
      { title: REQ.title, body: REQ.body, type: 'bug' },
      {
        appVersion: '0.0.112',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: '25.5.0',
        region: 'cn',
      },
      PLATFORM_IDENTITY,
      'Carol',
    );
    expect(postIssue).toHaveBeenCalledTimes(1);
    expect(postIssue.mock.calls[0]![0]).toEqual(PLATFORM_IDENTITY);
    const posted = postIssue.mock.calls[0]![1]();
    expect(posted.title).toBe('用户改过的标题');
    expect(posted.type).toBe('feature');
    expect(posted.appVersion).toBe('0.0.112');
    expect(posted.userName).toBe('公开昵称');
    expect(posted.description).toContain('用户改过的正文');
    expect(posted.description).toContain('**版本区域**: CN');
    expect(posted.description).toContain('**OS**: darwin arm64 (25.5.0)');
    expect(posted.description).toContain('**界面语言**: ja');
    expect(res).toEqual({
      ok: true,
      issueNumber: 80,
      issueUrl: 'https://github.com/makecindy/cindy/issues/80',
      finalTitle: '用户改过的标题',
      editedByUser: true,
    });
  });

  it('env 块只标注非默认区域: cn → CN / dev → Dev,global 省略该行', async () => {
    for (const [region, label] of [
      ['cn', '**版本区域**: CN'],
      ['dev', '**版本区域**: Dev'],
    ] as const) {
      const { deps, confirm, postIssue } = makeDeps({ getRegion: () => region });
      await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
      // 卡片展示的区域必须与最终写进 issue 的是同一个值。
      expect(confirm.mock.calls[0]![2]).toMatchObject({ region });
      expect(postIssue.mock.calls[0]![1]().description).toContain(label);
    }
  });

  it('global 是默认区域: 不写版本区域行,「没有这一行」即国际版', async () => {
    const { deps, confirm, postIssue } = makeDeps({ getRegion: () => 'global' });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    // 区域本身照常传给卡片(卡片自己决定不渲染),但正文里不能出现这一行。
    expect(confirm.mock.calls[0]![2]).toMatchObject({ region: 'global' });
    const description = postIssue.mock.calls[0]![1]().description!;
    expect(description).not.toContain('版本区域');
    expect(description).not.toContain('global');
    // 其余 env 行不受影响,不能因为省略区域行把 env 块整段搞坏。
    expect(description).toContain('**OS**: darwin arm64 (25.5.0)');
    expect(description).toContain('**界面语言**: zh-CN');
  });

  it('身份解析收到当前 session workingDir', async () => {
    const resolveSubmissionIdentity = vi.fn(async () => PLATFORM_IDENTITY);
    const { deps } = makeDeps({ resolveSubmissionIdentity });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    expect(resolveSubmissionIdentity).toHaveBeenCalledWith('/repo');
  });

  it('未编辑时 editedByUser=false;未回传 uiLanguage 时用 fallback locale', async () => {
    const { deps, postIssue } = makeDeps({
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
        publicName: 'Carol',
      })),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true, editedByUser: false });
    expect(postIssue.mock.calls[0]![1]().description).toContain('**界面语言**: en');
  });

  it('membership 没有展示名时不提供建议值，仍使用用户确认的匿名署名', async () => {
    const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(
      async (): Promise<IssueConfirmDecision> => ({
        confirmed: true,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
        publicName: '匿名',
        uiLanguage: 'zh-CN',
      }),
    );
    const { deps, postIssue } = makeDeps({ getSubmitterName: () => undefined, confirm });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(confirm.mock.calls[0]![4]).toBeUndefined();
    expect(postIssue.mock.calls[0]![1]().userName).toBe('匿名');
  });

  it('网络重试重建 body 时锁定用户确认的公开署名，不重新读取 membership 展示名', async () => {
    const getSubmitterName = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce('Account A')
      .mockReturnValueOnce('Account B');
    const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(
      async (): Promise<IssueConfirmDecision> => ({
        confirmed: true,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
        publicName: '用户确认的昵称',
        uiLanguage: 'zh-CN',
      }),
    );
    const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(
      async (_identity, bodyFactory) => {
        expect(bodyFactory().userName).toBe('用户确认的昵称');
        expect(bodyFactory().userName).toBe('用户确认的昵称');
        return { githubIssue: { number: 80, url: 'https://example.com/issues/80' } };
      },
    );
    const { deps } = makeDeps({ getSubmitterName, confirm, postIssue });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(confirm.mock.calls[0]![4]).toBe('Account A');
    expect(getSubmitterName).toHaveBeenCalledTimes(1);
  });

  it('平台代发没有确认有效公开署名时不提交', async () => {
    for (const publicName of [undefined, '', 'line 1\nline 2']) {
      const { deps, postIssue } = makeDeps({
        confirm: vi.fn(async () => ({
          confirmed: true as const,
          title: REQ.title,
          body: REQ.body,
          type: REQ.type,
          publicName,
        })),
      });
      const res = await submitGithubIssueWithConfirm(deps, REQ);
      expect(res).toMatchObject({ ok: false, errorCode: 'USER_CANCELLED' });
      expect(postIssue).not.toHaveBeenCalled();
    }
  });

  it('clamp: 超长 body 被裁但 env 块完整保留;超长 title 裁到 200', async () => {
    const longBody = 'x'.repeat(6000);
    const longTitle = 't'.repeat(300);
    const { deps, postIssue } = makeDeps({
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: longTitle,
        body: longBody,
        type: 'bug' as const,
        publicName: 'Carol',
        uiLanguage: 'zh-CN',
      })),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true, finalTitle: 't'.repeat(200) });
    const posted = postIssue.mock.calls[0]![1]();
    expect(posted.description!.length).toBeLessThanOrEqual(5000);
    expect(posted.description).toContain('**版本区域**: CN');
    expect(posted.description).toContain('**界面语言**: zh-CN');
  });

  it('postIssue 抛错映射: status 0→NETWORK_ERROR / 401→AUTH_NOT_READY / 500→SERVER_ERROR', async () => {
    for (const [statusCode, errorCode] of [
      [0, 'NETWORK_ERROR'],
      [401, 'AUTH_NOT_READY'],
      [500, 'SERVER_ERROR'],
    ] as const) {
      const err = Object.assign(new Error('boom'), { statusCode });
      const { deps } = makeDeps({ postIssue: vi.fn(async () => Promise.reject(err)) });
      const res = await submitGithubIssueWithConfirm(deps, REQ);
      expect(res).toMatchObject({ ok: false, errorCode });
    }
  });

  it('已绑定身份会展示并严格按该身份提交', async () => {
    const identity = { kind: 'github-user', login: 'octocat' } as const;
    const { deps, confirm, postIssue } = makeDeps({
      resolveSubmissionIdentity: async (): Promise<IssueSubmissionIdentity> => identity,
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(confirm.mock.calls[0]![3]).toEqual(identity);
    expect(confirm.mock.calls[0]![4]).toBeUndefined();
    expect(postIssue.mock.calls[0]![0]).toEqual(identity);
    expect(postIssue.mock.calls[0]![1]()).not.toHaveProperty('userName');
  });

  it('身份解析失败时不弹确认卡、不提交', async () => {
    const error = Object.assign(new Error('GitHub token 已失效，请重新绑定'), {
      issueErrorCode: 'AUTH_NOT_READY' as const,
    });
    const { deps, confirm, postIssue } = makeDeps({
      resolveSubmissionIdentity: async () => Promise.reject(error),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: false, errorCode: 'AUTH_NOT_READY' });
    expect(confirm).not.toHaveBeenCalled();
    expect(postIssue).not.toHaveBeenCalled();
  });

  it('用户身份提交失败时只调用一次该身份，不切换平台重试', async () => {
    const identity = { kind: 'github-user', login: 'octocat' } as const;
    const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(async () => {
      throw Object.assign(new Error('repo issue 权限不足'), {
        issueErrorCode: 'AUTH_NOT_READY' as const,
      });
    });
    const { deps } = makeDeps({
      resolveSubmissionIdentity: async () => identity,
      postIssue,
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: false, errorCode: 'AUTH_NOT_READY' });
    expect(postIssue).toHaveBeenCalledTimes(1);
    expect(postIssue.mock.calls[0]![0]).toEqual(identity);
  });
});
