/**
 * 截图交给新任务 (主窗口侧)。
 *
 * main 已把截图按粘贴图片同一条草稿链路入仓, 这里只写 New Maker 草稿:
 * - 「问 Cindy」: 截图追加到新任务草稿, 保留已有文字与附件, 用户自己写问题再发;
 * - 「翻译 / 解释 / 提取文字」: 一键出结果 —— 截图 + 预设提示词作为新任务直接发出
 *   (用户点的就是这个动作, 不再叠确认)。发送走输入框的普通发送路径
 *   (requestComposerSubmit), 模型、权限、建任务逻辑都不绕过。用户原来的新任务
 *   草稿先存下, 发送完成后放回去; 迟迟没发出时把它与截图草稿合并, 不丢内容。
 *
 * 发出的消息仍是本机用户亲手触发的输入, 不加消息来源标签 (见
 * docs/product-rules/message-source.md)。
 */

import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import i18n from '@/i18n';
import { requestComposerSubmit, takeComposerSubmitRequest } from '@/lib/composerActionsBus';
import {
  getDataOwnerGeneration,
  isDataOwnerIdCurrent,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  draftHasContent,
  captureDraftRecoveryScope,
  getDraft,
  plainTextToTiptapDoc,
  saveDraft,
  type ComposerDraft,
} from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import type { RegionScreenshotComposeRequest } from '../../../shared/regionScreenshot';

const RESTORE_POLL_MS = 500;
const RESTORE_WAIT_MS = 30_000;
let finishPendingRestore: (() => void) | null = null;

function screenshotAttachment(request: RegionScreenshotComposeRequest): AttachedFile {
  return {
    id: crypto.randomUUID(),
    name: request.filename,
    // 与剪贴板粘贴的 `clipboard://paste-*` 同型: 图片附件以 url 为准, path 只标识来源。
    path: `clipboard://screenshot-${request.id}`,
    ext: '.png',
    size: request.bytes,
    category: 'image',
    mimeType: 'image/png',
    url: request.url,
    originalName: request.filename,
  };
}

const hasAttachment = (draft: ComposerDraft | undefined, url: string) =>
  !!draft?.attachments.some((file) => file.url === url);

/** 发送完成 (草稿里不再有这张截图) 后放回用户原来的草稿; 一直没发出则合并两份。 */
function restoreAfterSend(previous: ComposerDraft, url: string): void {
  const startedAt = Date.now();
  const owner = getDataOwnerGeneration();
  const scope = captureDraftRecoveryScope(NEW_MAKER_DRAFT_KEY);
  let timer: ReturnType<typeof setTimeout>;
  const restore = () => {
    clearTimeout(timer);
    if (finishPendingRestore === restore) finishPendingRestore = null;
    if (isDataOwnerIdCurrent(owner)) takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY);
    const current = scope.get();
    if (!draftHasContent(current)) {
      scope.save(previous);
      return;
    }
    scope.save({
      ...previous,
      text: {
        type: 'doc',
        content: [...(previous.text?.content ?? []), ...(current?.text?.content ?? [])],
      },
      attachments: [
        ...new Map(
          [...previous.attachments, ...(current?.attachments ?? [])].map((file) => [
            file.url ?? file.path,
            file,
          ]),
        ).values(),
      ],
      quotes: [...(previous.quotes ?? []), ...(current?.quotes ?? [])],
      browserComments: [...(previous.browserComments ?? []), ...(current?.browserComments ?? [])],
    });
  };
  finishPendingRestore = restore;
  const check = () => {
    if (!isDataOwnerIdCurrent(owner)) {
      restore();
      return;
    }
    const current = getDraft(NEW_MAKER_DRAFT_KEY);
    if (!hasAttachment(current, url)) {
      restore();
      return;
    }
    if (Date.now() - startedAt < RESTORE_WAIT_MS) {
      timer = setTimeout(check, RESTORE_POLL_MS);
      return;
    }
    restore();
  };
  timer = setTimeout(check, RESTORE_POLL_MS);
}

export function applyScreenshotComposeRequest(
  request: RegionScreenshotComposeRequest,
  navigate: (path: string) => void,
): void {
  if (!isDataOwnerPushStampCurrent(request.ownerStamp)) return;
  // 先收回上一轮保管的草稿，再开始下一轮；旧 timer 不能把原稿遗失或覆盖新稿。
  finishPendingRestore?.();
  takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY);
  const attachment = screenshotAttachment(request);
  const existing = getDraft(NEW_MAKER_DRAFT_KEY);
  if (request.action === 'ask') {
    saveDraft(
      NEW_MAKER_DRAFT_KEY,
      {
        text: existing?.text ?? null,
        attachments: [...(existing?.attachments ?? []), attachment],
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
        focusAtEnd: true,
      },
      { preserveRemoteOptimisticRecovery: true },
    );
    navigate('/cc-agent/new');
    return;
  }
  const prompt = i18n.t(`regionScreenshot.prompt.${request.action}`);
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [attachment],
  });
  navigate('/cc-agent/new');
  requestComposerSubmit({ storageKey: NEW_MAKER_DRAFT_KEY, attachmentUrl: request.url });
  if (existing && draftHasContent(existing)) restoreAfterSend(existing, request.url);
}
