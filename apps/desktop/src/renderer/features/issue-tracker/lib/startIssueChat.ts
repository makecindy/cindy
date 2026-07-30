/**
 * startIssueChat —— 从 Issue 页一键开一个预填了 `/issue` 的新对话。
 *
 * 复用 contacts / Skillhub 的「不预创建会话」模式:只把命令预填进系统原生的
 * New Maker 草稿(composerDraftStore 以 NEW_MAKER_DRAFT_KEY 为键),调用方随后
 * navigate('/cc-agent/new')。用户在那里自己选 agent / 模型后回车,走正常建会话
 * 路径 —— 不绕过任何会话创建逻辑,也**不自动发送**(他还要补充描述)。
 *
 * 为什么预填纯文本就够:命令识别是发送时对消息文本跑正则
 * (`CCAgentSessionView.maybeDispatchDesktopSlashCommand`),不依赖编辑器里的
 * 命令 mark;新会话的首条 pending 消息同样经过那条识别路径。
 *
 * 同时重置草稿的远程目标(workingDir / device-link):提交反馈用的是本机的 Cindy
 * 登录态与本机插件配置,残留的远程草稿会把会话发到对端机器,issue 就成了用对端
 * 账号提交的 —— 用户在这台机器上点的按钮,结果落到另一台,不可接受。
 */

import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { patchDraft } from '@/state/newMakerDraft';

/** 末尾留一个空格:光标停在命令后面,用户可以直接接着写描述。 */
export const ISSUE_COMMAND_DRAFT_TEXT = '/issue ';

export function prefillIssueCommandDraft(): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(ISSUE_COMMAND_DRAFT_TEXT),
    attachments: [],
  });
  patchDraft({
    workingDir: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
  });
}
