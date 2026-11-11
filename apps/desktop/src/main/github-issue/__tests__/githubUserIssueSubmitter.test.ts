import { describe, expect, it, vi } from 'vitest';

import {
  PLATFORM_ISSUE_SUBMISSION_IDENTITY,
  postGithubIssueAsUser,
  resolveGithubIssueSubmissionChoices,
  type GithubUserIssueSubmitterDeps,
} from '../githubUserIssueSubmitter';

function makeDeps(over: Partial<GithubUserIssueSubmitterDeps> = {}): GithubUserIssueSubmitterDeps {
  return {
    isGithubGhostEnabled: () => true,
    isGithubCredentialSaved: () => true,
    isGithubGhostDisabledForWorkdir: () => false,
    callGhostTool: vi.fn(async (request) => {
      const operation = request.args.name;
      if (operation === 'get_current_user') {
        return { ok: true as const, result: { data: { login: 'octocat' } } };
      }
      return {
        ok: true as const,
        result: {
          data: { number: 469, html_url: 'https://github.com/makecindy/cindy/issues/469' },
        },
      };
    }),
    ...over,
  };
}

describe('resolveGithubIssueSubmissionChoices', () => {
  it('已启用且凭证有效时保留平台默认并追加 GitHub 用户选项', async () => {
    const deps = makeDeps();
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      githubUser: { kind: 'github-user', login: 'octocat' },
    });
    expect(deps.callGhostTool).toHaveBeenCalledWith({
      ghostId: 'cindy-github',
      tool: 'call_tool',
      args: { name: 'get_current_user', args: {} },
    });
  });

  it('未绑定或插件未启用时走平台身份且不调用插件', async () => {
    for (const over of [
      { isGithubGhostEnabled: () => false },
      { isGithubCredentialSaved: () => false },
    ]) {
      const deps = makeDeps(over);
      await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
        platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      });
      expect(deps.callGhostTool).not.toHaveBeenCalled();
    }
  });

  it('当前 workdir 禁用 cindy-github 时走平台身份且不调用插件', async () => {
    const deps = makeDeps({ isGithubGhostDisabledForWorkdir: (workdir) => workdir === '/repo' });
    await expect(resolveGithubIssueSubmissionChoices(deps, '/repo')).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(deps.callGhostTool).not.toHaveBeenCalled();
  });

  it('插件 readiness 读取异常时仍返回平台身份', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { warn },
      isGithubGhostEnabled: () => {
        throw new Error('plugin registry unavailable');
      },
    });
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(deps.callGhostTool).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('可选身份日志失败时仍返回平台身份', async () => {
    const deps = makeDeps({
      logger: {
        warn: () => {
          throw new Error('logger unavailable');
        },
      },
      isGithubGhostEnabled: () => {
        throw new Error('plugin registry unavailable');
      },
    });
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
  });

  it('插件运行时不可用时在确认前回退平台身份', async () => {
    const deps = makeDeps({
      callGhostTool: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'GHOST_CRASHED',
        message: '插件启动失败',
      })),
    });
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
  });

  it('已保存但失效的 token 只隐藏用户选项，不阻断平台 Bot', async () => {
    for (const message of [
      'GitHub token 未配置或已失效',
      'GitHub API HTTP 403 Forbidden',
      '凭证「github_pat」尚未配置',
    ]) {
      const warn = vi.fn();
      const deps = makeDeps({
        logger: { warn },
        callGhostTool: vi.fn(async () => ({
          ok: false as const,
          errorCode: 'INTERNAL',
          message,
        })),
      });
      await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
        platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(message);
    }
  });

  it('确认前身份探测超时时快速回退平台身份', async () => {
    const deps = makeDeps({
      identityProbeTimeoutMs: 1,
      callGhostTool: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true as const, result: { data: { login: 'octocat' } } };
      }),
    });
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
  });

  it('get_current_user 成功但缺少 login 时只隐藏半残身份', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { warn },
      callGhostTool: vi.fn(async () => ({ ok: true as const, result: { data: {} } })),
    });
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('postGithubIssueAsUser', () => {
  const IDENTITY = { kind: 'github-user', login: 'octocat' } as const;
  const BODY = {
    title: '让 /issue 支持用户本人身份',
    description: '## 诉求\n使用绑定账号提交\n\n---\n**OS**: darwin arm64 (25.5.0)',
    type: 'feature' as const,
    appVersion: '0.1.6',
    userName: 'Carol',
  };

  it('创建前复核 login，并解析 create_issue 的 data 结果', async () => {
    const deps = makeDeps();
    await expect(postGithubIssueAsUser(deps, IDENTITY, BODY)).resolves.toEqual({
      githubIssue: {
        number: 469,
        url: 'https://github.com/makecindy/cindy/issues/469',
      },
    });
    expect(deps.callGhostTool).toHaveBeenCalledTimes(2);
    expect(deps.callGhostTool).toHaveBeenNthCalledWith(2, {
      ghostId: 'cindy-github',
      tool: 'call_tool',
      args: {
        name: 'create_issue',
        args: {
          owner: 'makecindy',
          repo: 'cindy',
          title: BODY.title,
          body: expect.stringContaining('**反馈类型**: feature'),
          labels: ['feature'],
        },
      },
    });
  });

  it('确认后 login 改变时中止且不调用 create_issue', async () => {
    const callGhostTool = vi.fn(async () => ({
      ok: true as const,
      result: { data: { login: 'another-user' } },
    }));
    const deps = makeDeps({ callGhostTool });
    await expect(postGithubIssueAsUser(deps, IDENTITY, BODY)).rejects.toMatchObject({
      issueErrorCode: 'AUTH_NOT_READY',
    });
    expect(callGhostTool).toHaveBeenCalledTimes(1);
  });

  it('create_issue 失败时明确报错且没有平台提交入口', async () => {
    const callGhostTool = vi
      .fn<GithubUserIssueSubmitterDeps['callGhostTool']>()
      .mockResolvedValueOnce({ ok: true, result: { data: { login: 'octocat' } } })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INTERNAL',
        message: '没有权限(HTTP 403,token scope 不够或无该仓库权限)',
      });
    await expect(
      postGithubIssueAsUser(makeDeps({ callGhostTool }), IDENTITY, BODY),
    ).rejects.toMatchObject({ issueErrorCode: 'AUTH_NOT_READY' });
    expect(callGhostTool).toHaveBeenCalledTimes(2);
  });

  it('create_issue 返回缺少 number/url 时拒绝当作成功', async () => {
    const callGhostTool = vi
      .fn<GithubUserIssueSubmitterDeps['callGhostTool']>()
      .mockResolvedValueOnce({ ok: true, result: { data: { login: 'octocat' } } })
      .mockResolvedValueOnce({ ok: true, result: { data: { number: 469 } } });
    await expect(
      postGithubIssueAsUser(makeDeps({ callGhostTool }), IDENTITY, BODY),
    ).rejects.toMatchObject({ issueErrorCode: 'SERVER_ERROR' });
  });
});
