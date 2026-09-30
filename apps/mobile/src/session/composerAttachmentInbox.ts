/**
 * 跨屏 composer 附件信箱:文件浏览器等其它路由把附件投递给指定会话,
 * 会话页(栈下层保持挂载,不会因返回而重新 mount)在获得焦点时领取并
 * 合入自己的附件托盘。纯内存——附件引用的是被控端远程路径或 OSS ref,
 * 不需要跨启动持久化;进程重启信箱清空是可接受语义。
 */
import type { AnnotationStroke } from '@/session/imageAnnotationModel';
import type { RemoteSerializedAttachment } from '@/session/types';

const inbox = new Map<string, RemoteSerializedAttachment[]>();

/**
 * 圈点标注提交(文件浏览器 lightbox 画笔出口):只投递「图源 + 矢量笔迹」,
 * 烧录与上传由会话页的标注管线(useComposerImageAnnotations)统一执行,
 * 保证 annotated wire 标与托盘再编辑真相都走同一条链路。
 */
export interface ComposerAnnotationSubmission {
  /** 图源(file:// 取件缓存 / http presign / data:),会话页 materialize 时复制副本。 */
  displayUri: string;
  strokes: AnnotationStroke[];
  mimeType?: string;
  /** lightbox 已解码的图片尺寸(可选):仅供带笔迹 / 需光栅化时的烧录前预缩决策。 */
  naturalWidth?: number;
  naturalHeight?: number;
  /**
   * 处理失败后的回投次数(消费方维护):提交失败(槽满 / 读源失败 / 烧录失败)
   * 时把 submission 回投信箱等下次 focus 重试,用户画的笔迹不静默丢;达到上限
   * 后放弃(失败多为确定性原因,Alert 已提示,无限回投只会反复弹错)。
   */
  retryCount?: number;
}

const annotationInbox = new Map<string, ComposerAnnotationSubmission[]>();

export function queueComposerAnnotationSubmission(
  sessionId: string,
  submission: ComposerAnnotationSubmission,
): void {
  const key = sessionId.trim();
  if (!key) return;
  const list = annotationInbox.get(key) ?? [];
  list.push(submission);
  annotationInbox.set(key, list);
}

/** 领取并清空该会话的待烧录标注提交(幂等:无货返回空数组)。 */
export function drainComposerAnnotationSubmissions(
  sessionId: string,
): ComposerAnnotationSubmission[] {
  const key = sessionId.trim();
  const list = annotationInbox.get(key) ?? [];
  annotationInbox.delete(key);
  return list;
}

export function queueComposerAttachment(sessionId: string, attachment: RemoteSerializedAttachment): void {
  const key = sessionId.trim();
  if (!key) return;
  const list = inbox.get(key) ?? [];
  if (list.some((item) => item.id === attachment.id)) return;
  list.push(attachment);
  inbox.set(key, list);
}

/** 领取并清空该会话的待注入附件(幂等:无货返回空数组)。 */
export function drainComposerAttachments(sessionId: string): RemoteSerializedAttachment[] {
  const key = sessionId.trim();
  const list = inbox.get(key) ?? [];
  inbox.delete(key);
  return list;
}
