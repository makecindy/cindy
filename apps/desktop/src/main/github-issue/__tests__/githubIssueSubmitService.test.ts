/**
 * githubIssueSubmitService 单测 —— 确认门(cancelled/timeout 时 postIssue 零调用)、
 * 用户编辑版优先、env 块拼装与 fallback locale、clamp、错误映射。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitServiceDeps,
} from '../githubIssueSubmitService';
import type { IssueConfirmDecision } from '../issueConfirmBridge';

const REQ = {
  sessionId: 'sess-1',
  agentKind: 'codex' as const,
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
    resolveSubmissionChoices: async () => ({ platform: PLATFORM_IDENTITY }),
    postIssue,
    getAppVersion: () => '0.0.112',
    getOsInfo: () => ({ platform: 'darwin', arch: 'arm64', osVersion: '25.5.0' }),
    getTurnModelId: async () => 'gpt-5.6',
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
        harness: 'Codex',
        modelId: 'gpt-5.6',
        region: 'cn',
      },
      { platform: PLATFORM_IDENTITY },
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
    expect(posted.description).toContain('**Harness**: Codex');
    expect(posted.description).toContain('**Model ID**: ` gpt-5.6 `');
    expect(posted.description).toContain('**界面语言**: ja');
    expect(res).toEqual({
      ok: true,
      issueNumber: 80,
      issueUrl: 'https://github.com/makecindy/cindy/issues/80',
      finalTitle: '用户改过的标题',
      editedByUser: true,
      privacyRedacted: false,
    });
  });

  it('把三种 agentKind 映射为公开 Harness 全名', async () => {
    for (const [agentKind, harness] of [
      ['claude-code', 'Claude Code'],
      ['codex', 'Codex'],
      ['pi', 'Pi'],
    ] as const) {
      const { deps, confirm, postIssue } = makeDeps();
      await expect(
        submitGithubIssueWithConfirm(deps, { ...REQ, agentKind }),
      ).resolves.toMatchObject({ ok: true });
      expect(confirm.mock.calls[0]![2]).toMatchObject({ harness });
      expect(postIssue.mock.calls[0]![1]().description).toContain(`**Harness**: ${harness}`);
    }
  });

  it('在确认卡出现前锁定本轮模型 ID，之后切换 session 模型不会改写提交值', async () => {
    let selectedModel = 'claude-sonnet-4-5';
    const getTurnModelId = vi.fn(async () => selectedModel);
    const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(
      async (_sessionId, draft, env) => {
        expect(env.modelId).toBe('claude-sonnet-4-5');
        selectedModel = 'gpt-5.6';
        return {
          confirmed: true,
          title: draft.title,
          body: draft.body,
          type: draft.type,
          publicName: 'Carol',
          uiLanguage: 'zh-CN',
        };
      },
    );
    const { deps, postIssue } = makeDeps({ getTurnModelId, confirm });

    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });

    expect(getTurnModelId).toHaveBeenCalledWith('sess-1');
    expect(postIssue.mock.calls[0]![1]().description).toContain(
      '**Model ID**: ` claude-sonnet-4-5 `',
    );
    expect(postIssue.mock.calls[0]![1]().description).not.toContain(
      '**Model ID**: ` gpt-5.6 `',
    );
  });

  it('把自定义模型 ID 规范为有界单行值，查找失败时使用 unknown 且不阻断提交', async () => {
    const injected = `custom-model\n**Injected**: @maintainers \`value\` ${'x'.repeat(300)}`;
    const { deps, confirm, postIssue } = makeDeps({
      getTurnModelId: async () => injected,
    });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    const confirmedModelId = confirm.mock.calls[0]![2].modelId;
    expect(confirmedModelId).toHaveLength(200);
    expect(confirmedModelId).not.toMatch(/[\r\n]/);
    expect(postIssue.mock.calls[0]![1]().description).toContain(
      '**Model ID**: `` ' + confirmedModelId + ' ``',
    );
    expect(postIssue.mock.calls[0]![1]().description).not.toContain('\n**Injected**:');

    const fallback = makeDeps({
      getTurnModelId: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(submitGithubIssueWithConfirm(fallback.deps, REQ)).resolves.toMatchObject({
      ok: true,
    });
    expect(fallback.confirm.mock.calls[0]![2]).toMatchObject({ modelId: 'unknown' });
  });

  it('agent 初稿中的常见敏感信息在确认前自动脱敏,并标记隐私处理', async () => {
    const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(async (_sessionId, draft) => ({
      confirmed: true,
      title: draft.title,
      body: draft.body,
      type: draft.type,
      publicName: 'Carol',
      uiLanguage: 'zh-CN',
    }));
    const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(async () => ({
      githubIssue: { number: 81, url: 'https://github.com/makecindy/cindy/issues/81' },
    }));
    const { deps } = makeDeps({ confirm, postIssue });
    const fakeApiKey = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');
    const req = {
      ...REQ,
      title: `崩溃日志含 ${fakeApiKey}`,
      body: '邮箱 carol@example.com，日志位于 /Users/carol/project/app.log',
    };

    const result = await submitGithubIssueWithConfirm(deps, req);
    expect(confirm.mock.calls[0]![1]).toMatchObject({
      title: '崩溃日志含 [REDACTED:api-key]',
      body: '邮箱 [REDACTED:email]，日志位于 ~/project/app.log',
    });
    expect(postIssue).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, privacyRedacted: true });
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

  it('身份选项解析收到当前 session workingDir', async () => {
    const resolveSubmissionChoices = vi.fn(async () => ({ platform: PLATFORM_IDENTITY }));
    const { deps } = makeDeps({ resolveSubmissionChoices });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    expect(resolveSubmissionChoices).toHaveBeenCalledWith('/repo');
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

  it('已绑定身份作为额外选项展示，并严格按用户选择提交', async () => {
    const identity = { kind: 'github-user', login: 'octocat' } as const;
    const submissionChoices = { platform: PLATFORM_IDENTITY, githubUser: identity } as const;
    const confirm = vi.fn<GithubIssueSubmitServiceDeps['confirm']>(async () => ({
      confirmed: true as const,
      title: REQ.title,
      body: REQ.body,
      type: REQ.type,
      submissionIdentity: identity,
      uiLanguage: 'zh-CN',
    }));
    const { deps, postIssue } = makeDeps({
      resolveSubmissionChoices: async () => submissionChoices,
      confirm,
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(confirm.mock.calls[0]![3]).toEqual(submissionChoices);
    expect(confirm.mock.calls[0]![4]).toBe('Carol');
    expect(postIssue.mock.calls[0]![0]).toEqual(identity);
    const directBody = postIssue.mock.calls[0]![1]();
    expect(directBody).not.toHaveProperty('userName');
    expect(directBody.description).toContain('**Harness**: Codex');
    expect(directBody.description).toContain('**Model ID**: ` gpt-5.6 `');
  });

  it('身份选项解析意外失败时不弹确认卡、不提交', async () => {
    const error = Object.assign(new Error('GitHub token 已失效，请重新绑定'), {
      issueErrorCode: 'AUTH_NOT_READY' as const,
    });
    const { deps, confirm, postIssue } = makeDeps({
      resolveSubmissionChoices: async () => Promise.reject(error),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: false, errorCode: 'AUTH_NOT_READY' });
    expect(confirm).not.toHaveBeenCalled();
    expect(postIssue).not.toHaveBeenCalled();
  });

  it('平台代发成功后记账,带公开署名、不带 githubLogin', async () => {
    const onSubmitted = vi.fn();
    const { deps } = makeDeps({ onSubmitted });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    const record = onSubmitted.mock.calls[0]![0];
    expect(record).toMatchObject({
      number: 80,
      url: 'https://github.com/makecindy/cindy/issues/80',
      title: REQ.title,
      type: 'bug',
      identity: 'platform',
      publicName: 'Carol',
    });
    expect(record).not.toHaveProperty('githubLogin');
    expect(Number.isFinite(Date.parse(record.submittedAt))).toBe(true);
  });

  it('GitHub 用户直发成功后记账,带 login、不带公开署名', async () => {
    const identity = { kind: 'github-user', login: 'octocat' } as const;
    const onSubmitted = vi.fn();
    const { deps } = makeDeps({
      resolveSubmissionChoices: async () => ({
        platform: PLATFORM_IDENTITY,
        githubUser: identity,
      }),
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
        submissionIdentity: identity,
      })),
      onSubmitted,
    });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    const record = onSubmitted.mock.calls[0]![0];
    expect(record).toMatchObject({ identity: 'github-user', githubLogin: 'octocat' });
    expect(record).not.toHaveProperty('publicName');
  });

  it('记账的 url 由 issue 号派生,不采纳 postIssue 返回的原值', async () => {
    // 账本**读取**侧用 isMyIssueUrl 强校验(必须指向本仓这一号 issue)。写入侧存原值
    // 就两侧口径不一:返回 API 链接或别的 host 时,这条记录写得进去、读出来却被当坏
    // 数据过滤掉 —— 平台读接口未就绪 / 离线时,用户看不到自己刚提交的那条。
    const onSubmitted = vi.fn();
    const { deps } = makeDeps({
      postIssue: vi.fn(async () => ({
        githubIssue: { number: 80, url: 'https://api.github.com/repos/makecindy/cindy/issues/80' },
      })),
      onSubmitted,
    });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({ ok: true });
    expect(onSubmitted.mock.calls[0]![0].url).toBe('https://github.com/makecindy/cindy/issues/80');
  });

  it('记账用的是用户确认版标题与类型,不是 agent 传入的', async () => {
    const onSubmitted = vi.fn();
    const { deps } = makeDeps({
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: '用户改过的标题',
        body: '用户改过的正文',
        type: 'feature' as const,
        publicName: 'Carol',
      })),
      onSubmitted,
    });
    await submitGithubIssueWithConfirm(deps, REQ);
    expect(onSubmitted.mock.calls[0]![0]).toMatchObject({
      title: '用户改过的标题',
      type: 'feature',
    });
  });

  it('未提交(取消 / 提交失败)时不记账', async () => {
    const cancelled = vi.fn();
    await submitGithubIssueWithConfirm(
      makeDeps({
        confirm: vi.fn(async () => ({ confirmed: false as const, reason: 'cancelled' as const })),
        onSubmitted: cancelled,
      }).deps,
      REQ,
    );
    expect(cancelled).not.toHaveBeenCalled();

    const failed = vi.fn();
    await submitGithubIssueWithConfirm(
      makeDeps({
        postIssue: vi.fn(async () =>
          Promise.reject(Object.assign(new Error('x'), { statusCode: 500 })),
        ),
        onSubmitted: failed,
      }).deps,
      REQ,
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it('记账抛错不影响已经成功的提交结果', async () => {
    const { deps } = makeDeps({
      onSubmitted: () => {
        throw new Error('ledger disk full');
      },
    });
    await expect(submitGithubIssueWithConfirm(deps, REQ)).resolves.toMatchObject({
      ok: true,
      issueNumber: 80,
    });
  });

  it('用户身份提交失败时只调用一次该身份，不切换平台重试', async () => {
    const identity = { kind: 'github-user', login: 'octocat' } as const;
    const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(async () => {
      throw Object.assign(new Error('repo issue 权限不足'), {
        issueErrorCode: 'AUTH_NOT_READY' as const,
      });
    });
    const { deps } = makeDeps({
      resolveSubmissionChoices: async () => ({
        platform: PLATFORM_IDENTITY,
        githubUser: identity,
      }),
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
        submissionIdentity: identity,
      })),
      postIssue,
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: false, errorCode: 'AUTH_NOT_READY' });
    expect(postIssue).toHaveBeenCalledTimes(1);
    expect(postIssue.mock.calls[0]![0]).toEqual(identity);
  });
});
