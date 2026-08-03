/**
 * startContactsAiSession — 通讯录"让 AI 帮我整理"引导的草稿预填。
 *
 * 复用 Skillhub 的"不预创建会话"模式: 把引导语预填进系统原生的 New Maker
 * 草稿(composerDraftStore 以 NEW_MAKER_DRAFT_KEY 为键), 调用方随后
 * navigate('/cc-agent/new'), 用户在那里用原生入口选 agent/模型后发送,
 * 走正常建会话路径 — 不绕过任何会话创建逻辑。
 *
 * 同时把草稿的工作区目标复位成干净的本机对话态(resetDraftWorkspaceTargets):
 * 通讯录是本机全局库, 残留的远程草稿会把引导会话发到对端机器, 那边查到的是另一台
 * 机器的通讯录; 残留的 extraDirs 还会让这段引导对话继承对无关本地目录的读取授权。
 *
 * 走共享函数而不是手写字段清单 —— 这里原先手抄的三个字段其实已由 patchDraft 的级联
 * 处理, 真正需要清的 extraDirs 反而漏了(#1103 review 在同源的 issue 预填入口发现)。
 */
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/NewMakerDraftRoute';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';

export function prefillContactsAiSessionDraft(promptText: string): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(promptText),
    attachments: [],
  });
  resetDraftWorkspaceTargets();
}
