/**
 * 编辑最后一条用户消息(对齐桌面 UserMessageEditBox + editLastUserMessage)。
 *
 * 语义:回退到这条消息(对话截断 + 文件回滚,与「回到此处」同一条 rewind 链路),
 * 再用编辑后的内容立即重发。手机端复用底部 composer 承载编辑态(与排队消息编辑
 * 同款),本模块只放与页面状态无关的纯逻辑:附件重建、带重试的 rewind 提交、
 * 错误文案与文件回滚提示。
 */
import { formatRemoteError } from '@/device-link/remoteStatus';
import {
  composerDocumentHasContent,
  composerDocumentsEqual,
  normalizeComposerDocument,
  type ComposerDocument,
} from '@/session/composerDocument';
import { i18n } from '@/i18n';
import {
  buildMobileRemoteFileAttachment,
  extractRemoteFileExt,
} from '@/session/attachments';
import type { NormalizedAttachment } from '@/session/messageNormalize';
import type { RewindPreviewPayload } from '@/session/rewindPreview';
import type { RemoteSerializedAttachment } from '@/session/types';

export type MessageEditRollbackHint =
  | { kind: 'files'; count: number }
  | { kind: 'conversation-only' }
  | null;

/**
 * 原消息附件 → composer 附件托盘条目,重发时原样带回被控端。语义同桌面
 * buildRewindDraftAttachments:图片沿用落库的 url(xdt-image:// 等由被控端解析),
 * 文件沿用被控端路径;都不是手机中转区对象,从托盘移除时不会触发 OSS 回收。
 */
export function buildMessageEditAttachments(
  attachments: readonly NormalizedAttachment[] | undefined,
  idPrefix: string,
): RemoteSerializedAttachment[] {
  const result: RemoteSerializedAttachment[] = [];
  (attachments ?? []).forEach((attachment, index) => {
    const id = `${idPrefix}:${index}`;
    if (attachment.kind === 'file') {
      const file = attachment.path ? buildMobileRemoteFileAttachment(attachment.path, { id }) : null;
      if (file) result.push({ ...file, name: attachment.name || file.name });
      return;
    }
    const uri = attachment.uri;
    if (!uri) return;
    const mimeType = attachment.mimeType ?? 'image/png';
    const ext = extractRemoteFileExt(attachment.name) || imageExtForMime(mimeType);
    const base64 = readDataUriBase64(uri);
    result.push({
      id,
      name: attachment.name,
      originalName: attachment.name,
      path: base64 !== null ? `clipboard://message-edit-${index + 1}` : uri,
      ext,
      size: 0,
      category: 'image',
      mimeType,
      ...(base64 !== null ? { base64 } : { url: uri }),
      ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
    });
  });
  return result;
}

/** 与桌面 RUNNING_RETRY_DEFAULTS 同预算(≈15s):点编辑已发出停止,这里消化停止收尾的尾差。 */
export const MESSAGE_EDIT_RUNNING_RETRY = { attempts: 20, delayMs: 750 } as const;

export async function commitMessageEditRewind<T>(input: {
  rewindCommit: (opts: { requireLatestUser: true; allowFileRestore?: false }) => Promise<T>;
  /** 预览判定只能截断对话时绑定 false,提交不得意外恢复文件(与桌面编辑框一致)。 */
  allowFileRestore?: false;
  /** 每次重试前确认这次编辑仍然有效;返回 false 时放弃,不再发起 rewind。 */
  stillCurrent?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<T> {
  const attempts = input.attempts ?? MESSAGE_EDIT_RUNNING_RETRY.attempts;
  const delayMs = input.delayMs ?? MESSAGE_EDIT_RUNNING_RETRY.delayMs;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // requireLatestUser:被控端在软删事务前权威核对目标仍是最新一条用户消息,
  // 手机已加载窗口的判定只是入口门槛(自动化 / 另一台控制端可能刚追加了消息)。
  const opts = {
    requireLatestUser: true as const,
    ...(input.allowFileRestore === false ? { allowFileRestore: false as const } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await input.rewindCommit(opts);
    } catch (err) {
      if (!isMessageEditErrorCode(err, 'SESSION_RUNNING') || attempt >= attempts) throw err;
      await sleep(delayMs);
      if (input.stillCurrent && !input.stillCurrent()) throw err;
    }
  }
}

export function messageEditRollbackHint(preview: RewindPreviewPayload | null | undefined): MessageEditRollbackHint {
  if (!preview?.canRewind) return null;
  const count = preview.filesChanged?.length ?? 0;
  if (count > 0) return { kind: 'files', count };
  return preview.conversationOnly ? { kind: 'conversation-only' } : null;
}

/** 编辑重发失败时给用户看的文案;未识别的错误交给调用方的通用远程错误文案。 */
export function messageEditErrorText(err: unknown): string | null {
  if (isMessageEditErrorCode(err, 'SESSION_RUNNING')) return i18n.t('session.messageEdit.stopTimeout');
  if (isMessageEditErrorCode(err, 'REWIND_TARGET_NOT_LATEST') || isMessageEditErrorCode(err, 'EDIT_NOT_LAST_MESSAGE')) {
    return i18n.t('session.messageEdit.notLast');
  }
  if (isMessageEditErrorCode(err, 'NO_PRIOR_ASSISTANT')) return i18n.t('session.messageEdit.noPriorAssistant');
  return null;
}

function isMessageEditErrorCode(err: unknown, code: string): boolean {
  const own = (err as { code?: unknown } | null)?.code;
  if (own === code) return true;
  return formatRemoteError(err).includes(code);
}

function readDataUriBase64(uri: string): string | null {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(uri);
  return match ? match[1] : null;
}

function imageExtForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  return '.png';
}

/**
 * 回退提交后页面已不在前台时,该任务草稿库的终态(幂等):
 * 〔未入队的替代内容〕+〔库里本来就有的内容〕+〔暂存草稿〕,每份各一次。
 * 编辑期间输入框内容不写草稿库(persist:false),所以此刻库里要么仍是暂存草稿
 * (替代消息没清过它,例如离场后才受理的发送),要么是 send 清空后的空草稿,
 * 要么是别的内容——只能由库内状态推导,不能由「发送是否受理」推导,否则
 * 暂存草稿会被复制两遍或丢掉。
 */
export function mergeMessageEditDraft(input: {
  stored: ComposerDocument | null;
  stash: ComposerDocument;
  /** 尚未进入发件箱的替代内容;已受理时传 null。 */
  replacement: ComposerDocument | null;
}): ComposerDocument {
  const stored = input.stored && !composerDocumentsEqual(input.stored, input.stash) ? input.stored : null;
  const nodes: ComposerDocument['nodes'] = [];
  for (const part of [input.replacement, stored, input.stash]) {
    if (!part || !composerDocumentHasContent(part)) continue;
    if (nodes.length > 0) nodes.push({ type: 'text', text: '\n\n' });
    nodes.push(...part.nodes);
  }
  return normalizeComposerDocument({ version: 1, nodes });
}
