/**
 * ghostMediaHandover — 意识面板媒体(图片/视频)拖进聊天输入框的「产物引渡」
 * renderer 侧。
 *
 * 链路:面板 dragstart 把自己的 `cindy-ghost://<id>/media/<指纹><后缀>`
 * 塞进 dataTransfer(直接拖 <a> 时浏览器默认带 href,即 /preview/ 形状,
 * 同样认)→ ChatInput 的 onDrop 识别该形状 → main 过闸
 * (ghosts:resolve-panel-media:指纹形状 + 账本归属 + mime 按账本)→
 * 图片复用「发送到对话」附件链路(media:cache-for-session 复制进会话缓存),
 * 视频以指纹仓磁盘路径落 file 附件,最后合入 composerDraftStore。
 *
 * 安全模型见 previewGate.ts 的 parseGhostMediaHandoverUrl 注释:跨边界只有
 * 指纹字符串,最终附件身份全部由主机构造;拖拽是 OS 级手势(脚本伪造不了),
 * 落进的也只是输入框附件托盘,发不发仍由用户决定。
 *
 * 视频与图片走不同落点:图片复制进会话缓存落图片附件(喂模型视觉通道);
 * 视频不复制字节(规则 25 不新写媒体缓存),以指纹仓磁盘路径落成与「从系统
 * 拖 .mp4 进聊天」同款的 file 类别路径附件——发送时路径透传,agent 用文件
 * 工具按需处理。托盘移除 file 附件不清理源文件,总仓 blob 安全。
 */

import type { TFunction } from 'i18next';

import { getMimeType, type AttachedFile } from '@/lib/fileTypes';
import { getDraft, saveDraft } from '@/lib/composerDraftStore';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

/** 引渡地址形状(renderer 侧只做粗筛,严校验在 main 闸口)。 */
const GHOST_MEDIA_URI_RE = /^cindy-ghost:\/\/[a-z0-9-]{1,32}\/(media|preview)\/\S+$/;

/**
 * 从 drop 的 dataTransfer 里取意识媒体地址;不是意识拖拽返回 null。
 * text/uri-list 优先(标准通道,面板 dragstart 与 <a> 默认拖拽都写它),
 * text/plain 兜底;uri-list 按规范可多行、# 开头是注释,取首条有效行。
 */
export function getGhostMediaUriFromDataTransfer(dt: DataTransfer): string | null {
  for (const type of ['text/uri-list', 'text/plain']) {
    const raw = dt.getData(type);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || candidate.startsWith('#')) continue;
      if (GHOST_MEDIA_URI_RE.test(candidate)) return candidate;
      break; // 首条有效行不是意识地址 → 整个 drop 不是引渡,交还常规链路
    }
  }
  return null;
}

/**
 * 把意识面板拖来的媒体落为会话附件(托盘可见,发送仍由用户决定)。
 * 失败 toast 即止——drop 已被本链路消费,不回落文件链路。
 */
export async function attachGhostMediaToSession(
  uri: string,
  sessionId: string,
  t: TFunction,
): Promise<void> {
  try {
    // main 过闸:归属/形状/mime 任一不过统一 NOT_FOUND。
    const resolved = await window.electronAPI.ghosts.resolvePanelMedia(uri);
    if (resolved.kind === 'video') {
      // 视频:不复制字节,直接以指纹仓磁盘路径落 file 类别附件(与从系统
      // 拖 .mp4 进聊天完全同款——发送时路径透传给 agent)。托盘移除 file
      // 附件不清理源文件,总仓 blob 不受影响。
      appendDraftAttachment(sessionId, {
        id: crypto.randomUUID(),
        name: resolved.name,
        path: resolved.absPath,
        ext: resolved.ext,
        size: resolved.size,
        category: 'file',
        mimeType: resolved.mimeType || getMimeType(resolved.ext, 'file'),
      });
      toast.success(t('chat.media.sentToChat'));
      return;
    }
    // 图片:与 ImageLightbox「发送到对话」同一条链路——复制进会话私有缓存
    // (托盘移除附件会删缓存文件,绝不直接引用总仓 blob)。
    const meta = await window.electronAPI.cacheMediaForSession({ url: resolved.url, sessionId });
    appendDraftAttachment(sessionId, {
      id: crypto.randomUUID(),
      name: meta.name,
      // 与 `clipboard://paste-*` 同型:图片附件以 url 为准,path 只是来源占位。
      path: `clipboard://ghost-drop-${Date.now()}`,
      ext: meta.ext,
      size: meta.size,
      category: 'image',
      mimeType: meta.mimeType || getMimeType(meta.ext, 'image'),
      url: meta.url,
      originalName: meta.name,
    });
    toast.success(t('chat.media.sentToChat'));
  } catch (err) {
    toast.error(extractIpcError(err)?.message ?? t('chat.media.sendToChatFailed'));
  }
}

/** 把一条附件合入会话草稿(托盘可见;其余草稿字段原样保留)。 */
function appendDraftAttachment(sessionId: string, attached: AttachedFile): void {
  const existing = getDraft(sessionId);
  saveDraft(
    sessionId,
    {
      text: existing?.text ?? null,
      attachments: [...(existing?.attachments ?? []), attached],
      quotes: existing?.quotes ?? [],
      browserComments: existing?.browserComments ?? [],
    },
    { preserveRemoteOptimisticRecovery: true },
  );
}
