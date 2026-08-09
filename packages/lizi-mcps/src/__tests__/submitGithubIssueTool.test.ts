/**
 * submit_github_issue 工具单测 —— schema 校验 + payload 整形(host 回调 mock 掉)。
 * 验证工具层契约: 参数边界、NO_SESSION_CONTEXT 短路、ok/错误码透传、trim。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerSubmitGithubIssueTool,
  type SubmitGithubIssueHostResult,
} from '../xdt-helper/submit_github_issue.js';

const VALID_ARGS = {
  title: '自动化任务列表的显示筛选切换后未被记住',
  body: '## 现象\n切到全部后再切回来,仍然只显示活跃任务。\n\n## 期望行为\n记住上次的显示选择。',
  type: 'bug',
};

function setup(opts?: {
  sessionId?: string | undefined;
  result?: SubmitGithubIssueHostResult;
}) {
  const sessionId = 'sessionId' in (opts ?? {}) ? opts?.sessionId : 'sess-1';
  const submit = vi.fn(
    async (): Promise<SubmitGithubIssueHostResult> =>
      opts?.result ?? {
        ok: true,
        issueNumber: 76,
        issueUrl: 'https://github.com/makecindy/cindy/issues/76',
        finalTitle: VALID_ARGS.title,
        editedByUser: false,
        privacyRedacted: false,
      },
  );
  const registry = new XdtHelperToolRegistry();
  registerSubmitGithubIssueTool(registry, {
    getSessionContext: () => ({
      sessionId,
      agentKind: 'claude-code',
      workingDir: '/tmp/wd',
    }),
    submit,
  });
  return { registry, submit };
}

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (!block || block.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

describe('submit_github_issue tool', () => {
  it('缺参数 → INVALID_ARGS, host 不被调', async () => {
    const { registry, submit } = setup();
    const res = await registry.call('submit_github_issue', {});
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('title 太短 / body 太短 / type 非法 → INVALID_ARGS', async () => {
    const { registry, submit } = setup();
    for (const args of [
      { ...VALID_ARGS, title: '短标题' },
      { ...VALID_ARGS, body: '太短' },
      { ...VALID_ARGS, type: 'question' },
      { ...VALID_ARGS, title: 'x'.repeat(121) },
      { ...VALID_ARGS, body: 'x'.repeat(4001) },
    ]) {
      const res = await registry.call('submit_github_issue', args);
      expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('无 sessionId → NO_SESSION_CONTEXT, host 不被调', async () => {
    const { registry, submit } = setup({ sessionId: undefined });
    const res = await registry.call('submit_github_issue', VALID_ARGS);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('ok 路径: host 收到 trim 后的参数, payload 透传 issue 信息', async () => {
    const { registry, submit } = setup();
    const res = await registry.call('submit_github_issue', {
      ...VALID_ARGS,
      title: `  ${VALID_ARGS.title}  `,
    });
    expect(submit).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      workingDir: '/tmp/wd',
      title: VALID_ARGS.title,
      body: VALID_ARGS.body,
      type: 'bug',
    });
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toEqual({
      ok: true,
      issue_number: 76,
      issue_url: 'https://github.com/makecindy/cindy/issues/76',
      final_title: VALID_ARGS.title,
      edited_by_user: false,
      privacy_redacted: false,
      open_source: {
        repository_url: 'https://github.com/makecindy/cindy',
        license: 'Apache-2.0',
        invitation:
          'Cindy is open source. If the user is interested, offer help with reproducing the issue, editing the source, adding tests, and preparing a pull request.',
      },
    });
  });

  it('host 错误码透传, isError=true', async () => {
    for (const errorCode of ['USER_CANCELLED', 'CONFIRM_TIMEOUT', 'NETWORK_ERROR'] as const) {
      const { registry } = setup({
        result: { ok: false, errorCode, message: `msg:${errorCode}` },
      });
      const res = await registry.call('submit_github_issue', VALID_ARGS);
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode });
    }
  });
});
