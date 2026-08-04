/**
 * 「点 /issue 开新对话」的草稿预填 —— 钉住两件事:
 *  1. 写进去的必须是能被命令正则识别的纯文本(不是自然语言指令);
 *  2. 必须把远程目标重置回本机 —— 否则会话会发到对端机器,issue 就成了用对端
 *     账号提交的。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveDraft = vi.fn();
const resetDraftWorkspaceTargets = vi.fn();

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: (...args: unknown[]) => saveDraft(...args),
  // 只需保持「文本原样进、结构化出」的可断言形状,不测 tiptap 序列化本身。
  plainTextToTiptapDoc: (text: string) => ({ type: 'doc', plain: text }),
}));

vi.mock('@/state/newMakerDraft', () => ({
  resetDraftWorkspaceTargets: () => resetDraftWorkspaceTargets(),
}));

const { ISSUE_COMMAND_DRAFT_TEXT, prefillIssueCommandDraft } = await import('../lib/startIssueChat');

describe('prefillIssueCommandDraft', () => {
  beforeEach(() => {
    saveDraft.mockClear();
    resetDraftWorkspaceTargets.mockClear();
  });

  it('把 /issue 预填进 New Maker 草稿,不带附件', () => {
    prefillIssueCommandDraft();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [key, draft] = saveDraft.mock.calls[0]!;
    expect(key).toBe('__new_maker_draft__');
    expect(draft).toEqual({
      text: { type: 'doc', plain: ISSUE_COMMAND_DRAFT_TEXT },
      attachments: [],
    });
  });

  it('预填文本能被发送路径的命令正则识别成 issue 命令', () => {
    // 与 CCAgentSessionView.maybeDispatchDesktopSlashCommand 同一条正则。
    const match = ISSUE_COMMAND_DRAFT_TEXT.match(/^\/(\S+)(?:\s+(.*))?$/s);
    expect(match?.[1]).toBe('issue');
    // 尾随空格不该被当成参数带进命令。
    expect(match?.[2] ?? '').toBe('');
  });

  it('用户在命令后补描述时,描述作为 args 传下去', () => {
    const match = `${ISSUE_COMMAND_DRAFT_TEXT}列表刷新按钮点了没反应`.match(
      /^\/(\S+)(?:\s+(.*))?$/s,
    );
    expect(match?.[1]).toBe('issue');
    expect(match?.[2]).toBe('列表刷新按钮点了没反应');
  });

  it('走共享的工作区复位入口(而不是手写字段清单)', () => {
    // 手写清单正是漏掉 extraDirs 目录授权的原因;复位语义与字段覆盖由
    // newMakerDraftWorkspaceReset.test.ts 单独钉住。
    prefillIssueCommandDraft();
    expect(resetDraftWorkspaceTargets).toHaveBeenCalledTimes(1);
  });
});
