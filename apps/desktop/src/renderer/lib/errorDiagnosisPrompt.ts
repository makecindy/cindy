/**
 * errorDiagnosisPrompt — 错误卡「诊断」：把错误和出错任务链接预填进新任务草稿。
 *
 * 沿用 issue 预填入口的「不预创建会话」模式：只写 New Maker 草稿并复位
 * 工作区目标，调用方随后 navigate('/cc-agent/new')。不自动发送，用户确认后再发。
 */
import type { TFunction } from 'i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import {
  draftHasContent,
  getDraft,
  plainTextToTiptapDoc,
  saveDraft,
} from '@/lib/composerDraftStore';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';

export interface ErrorDiagnosisSource {
  /** 卡片上给用户看的错误提示。 */
  message: string;
  /** 展开详情里的原始错误。 */
  details: string;
  reason?: string | null;
}

export function buildErrorDiagnosisPrompt(
  t: TFunction,
  sessionUrl: string | null,
  source: ErrorDiagnosisSource,
): string {
  const details = redactSensitiveText(source.details).trim();
  return t(sessionUrl ? 'chat.errorBanner.diagnosePrompt' : 'chat.errorBanner.diagnosePromptWithoutSession', {
    sessionUrl,
    message: redactSensitiveText(source.message).trim(),
    details: source.reason
      ? `${details}\nreason: ${redactSensitiveText(source.reason).trim()}`
      : details,
  });
}

/**
 * 新建任务页已有未发送的内容时不覆盖：以原草稿为底整体保留（附件、浏览器评论、插件交接、
 * 旧版引用、工作区目标等全部内容），只把诊断提示追加在正文之后。草稿为空时与其他预填入口一致，
 * 整体写入并复位工作区目标（避免残留的远程目标或额外授权目录带进诊断任务）。
 */
export function prefillErrorDiagnosisDraft(prompt: string): void {
  const existing = getDraft(NEW_MAKER_DRAFT_KEY);
  const added = plainTextToTiptapDoc(prompt);
  const existingContent = existing?.text?.content ?? [];
  // 与侧边栏「未发送」标记同一判据：清空后残留的空段落不算内容。
  if (existing && draftHasContent(existing)) {
    // 用户自己的未发送草稿：工作区目标（项目、远程电脑、额外授权目录）也属于它，原样保留。
    saveDraft(NEW_MAKER_DRAFT_KEY, {
      ...existing,
      text: { ...added, content: [...existingContent, ...(added.content ?? [])] },
    });
    return;
  }
  saveDraft(NEW_MAKER_DRAFT_KEY, { text: added, attachments: [] });
  resetDraftWorkspaceTargets();
}
