/**
 * startContactsAiSession — 通讯录"让 AI 帮我整理"引导的草稿预填。
 *
 * 复用 Skillhub 的"不预创建会话"模式: 把引导语预填进系统原生的 New Maker
 * 草稿(composerDraftStore 以 NEW_MAKER_DRAFT_KEY 为键), 调用方随后
 * navigate('/cc-agent/new'), 用户在那里用原生入口选 agent/模型后发送,
 * 走正常建会话路径 — 不绕过任何会话创建逻辑。
 *
 * 同时重置草稿的远程目标(workingDir/device-link): 通讯录是本机全局库,
 * 残留的远程草稿会把引导会话发到对端机器, 那边查到的是另一台机器的通讯录。
 */
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/NewMakerDraftRoute';
import { patchDraft } from '@/state/newMakerDraft';

export function prefillContactsAiSessionDraft(promptText: string): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(promptText),
    attachments: [],
  });
  patchDraft({
    workingDir: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
  });
}
