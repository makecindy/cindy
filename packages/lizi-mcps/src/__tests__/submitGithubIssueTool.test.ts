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
  it('要求按最小公开原则泛化用户原话与示例', () => {
    const { registry } = setup();
    const tool = registry.get('submit_github_issue');
    expect(tool?.description).toContain('Bug 和功能建议都遵循最小公开原则');
    expect(tool?.description).toContain('不要逐字复制用户消息');
    expect(tool?.description).toContain('不能识别所有语义隐私');
  });

  it('澄清流程交给 agent 判断,并与自动附加的当前任务环境区分', () => {
    const { registry } = setup();
    const tool = registry.get('submit_github_issue');
    expect(tool?.description).toContain('缺什么问什么');
    expect(tool?.description).toContain('不要套固定问卷或章节清单');
    expect(tool?.description).toContain('普通建议不必按缺陷来问');
    expect(tool?.description).toContain('和环境无关不必追问 Harness');
    expect(tool?.description).toContain('系统自动附加的 Harness / Model ID 是当前任务的快照');
    expect(tool?.description).toContain('不一定是出问题的那个');
    expect(tool?.description).toContain('提交时的任务环境');
    expect(tool?.description).toContain('本工具不能把对话里的图片传到 GitHub');
    expect(tool?.description).toContain('禁止写「已提供截图」');
    expect(tool?.description).toContain('不要写仓库路径、实现方案、验收清单');
    expect(tool?.inputShape.body.description).toContain('按这条反馈本身组织');
    expect(tool?.inputShape.body.description).not.toContain('bug 优先用');
    expect(tool?.inputShape.body.description).toContain('禁止声称截图已附');
    expect(tool?.inputShape.body.description).toContain('提交时的任务环境');
    expect(tool?.inputShape.body.description).toContain('实际故障');
    expect(tool?.inputShape.body.description).toContain(
      '不要复制系统自动附加的当前任务快照',
    );
    expect(tool?.inputShape.body.description).not.toMatch(
      /不要写环境信息\(客户端版本 \/ 版本区域 \/ OS \/ Harness \/ 模型 ID/,
    );
  });

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
      agentKind: 'claude-code',
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
