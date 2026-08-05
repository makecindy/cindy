/**
 * messageAttachmentPayload.ts
 * ---------------------------------------------------------------------------
 * renderer 侧 user attachment 的唯一转换边界。
 *
 * UI 附件来源可能是缓存 URL、真实文件路径，或缓存失败后的内存 base64。
 * 这里统一生成三种下游形态：发给 main 的 IPC payload、消息流即时渲染字段、
 * 以及持久化到 Message.content 的轻量引用。
 */

import type {
  AttachedFile,
  MentionedResource,
  SerializedAttachedFile,
} from '@/lib/fileTypes';
import type { FileRef, ImageRef } from '@/lib/imageRef';
import { getAgentInputAttachmentBlockType } from '../../shared/agentInputQueue';

export type InlineImageAttachment = {
  base64: string;
  mimeType: string;
  originalName?: string;
};

export type RenderImageAttachment = ImageRef | InlineImageAttachment;

export type SdkTextBlock = { type: 'text'; text: string };
export type SdkAttachmentBlock = {
  type: 'image' | 'file';
  path?: string;
  base64?: string;
  mimeType?: string;
  /**
   * 显式文件附件的原始磁盘路径(path 为 xdt-image:// 缓存 URL 时携带):
   * device-link 出方向据此识别「字节精确」语义跳过压缩;上传后即被剥掉,
   * 本机路径不会随消息发到被控端。
   */
  originalPath?: string;
};
export type SdkMentionBlock = {
  type: 'mention';
  name: string;
  path: string;
  kind: MentionedResource['type'];
};
export type SdkUserContentBlock = SdkTextBlock | SdkAttachmentBlock | SdkMentionBlock;

export type MakerUserMessage = {
  type: 'user';
  content: string | SdkUserContentBlock[];
};

export interface UserMessageAttachmentPayload {
  serializedFiles?: SerializedAttachedFile[];
  imageAttachments?: RenderImageAttachment[];
  fileAttachments?: FileRef[];
  persistImageRefs: ImageRef[];
  persistFileRefs: FileRef[];
}

type LegacyInlineAttachmentFields = {
  base64?: string;
  textContent?: string;
  truncated?: boolean;
};

function readLegacyInlineFields(file: AttachedFile | SerializedAttachedFile): LegacyInlineAttachmentFields {
  return file as LegacyInlineAttachmentFields;
}

export function serializeAttachedFiles(
  files?: readonly AttachedFile[],
): SerializedAttachedFile[] | undefined {
  return files?.map((file) => {
    const legacy = readLegacyInlineFields(file);
    return {
      id: file.id,
      name: file.name,
      path: file.path,
      ext: file.ext,
      size: file.size,
      category: file.category,
      mimeType: file.mimeType,
      ...(file.url ? { url: file.url, originalName: file.originalName ?? file.name } : {}),
      ...(file.annotated ? { annotated: true } : {}),
      ...(legacy.base64 ? { base64: legacy.base64 } : {}),
      ...(legacy.textContent !== undefined ? { textContent: legacy.textContent } : {}),
      ...(legacy.truncated !== undefined ? { truncated: legacy.truncated } : {}),
    };
  });
}

function buildImageAttachment(file: AttachedFile): RenderImageAttachment | null {
  if (file.category !== 'image') return null;
  if (file.url) {
    return {
      url: file.url,
      mimeType: file.mimeType,
      originalName: file.originalName ?? file.name,
      // 非破坏性标注:发送物化后 url 是烧录图,原图引用与矢量笔迹随消息
      // 持久化,历史图点开可继续编辑 / 撤销(imageRef.ts 字段注释)。
      ...(file.annotated && file.annotationSourceUrl && file.annotationStrokes?.length
        ? {
            annotationSourceUrl: file.annotationSourceUrl,
            annotationStrokes: file.annotationStrokes,
          }
        : {}),
    };
  }

  const legacyBase64 = readLegacyInlineFields(file).base64;
  if (!legacyBase64) return null;
  return {
    base64: legacyBase64,
    mimeType: file.mimeType,
    originalName: file.originalName ?? file.name,
  };
}

export function buildUserMessageAttachmentPayload(
  files?: readonly AttachedFile[],
): UserMessageAttachmentPayload {
  const serializedFiles = serializeAttachedFiles(files);
  const imageAttachments = files
    ?.map(buildImageAttachment)
    .filter((image): image is RenderImageAttachment => image !== null);
  const fileAttachments = files
    ?.filter((file) => file.category !== 'image')
    .map((file) => ({ name: file.name, path: file.path }));
  const persistImageRefs = imageAttachments?.filter((image): image is ImageRef => 'url' in image) ?? [];
  const persistFileRefs = fileAttachments ?? [];

  return {
    ...(serializedFiles && serializedFiles.length > 0 ? { serializedFiles } : {}),
    ...(imageAttachments && imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(fileAttachments && fileAttachments.length > 0 ? { fileAttachments } : {}),
    persistImageRefs,
    persistFileRefs,
  };
}

function buildAttachmentBlock(file: SerializedAttachedFile): SdkAttachmentBlock | null {
  const type = getAgentInputAttachmentBlockType(file.category, file.ext);
  if (file.url) {
    // 显式文件(选择器/拖拽)拷入缓存后 url 与原始磁盘 path 并存:把原始路径一并
    // 带上,message 形态的远程发送才能识别「字节精确」语义不压缩(队列形态的
    // files[] 本就双字段齐全,不需要这个补充)。
    const originalPath = file.path && !file.path.startsWith('clipboard://') && !file.path.startsWith('xdt-image://')
      ? file.path
      : undefined;
    return { type, path: file.url, mimeType: file.mimeType, ...(originalPath ? { originalPath } : {}) };
  }
  if (file.path && !file.path.startsWith('clipboard://')) {
    return { type, path: file.path, mimeType: file.mimeType };
  }

  const legacyBase64 = readLegacyInlineFields(file).base64;
  if (legacyBase64) {
    return { type, base64: legacyBase64, mimeType: file.mimeType };
  }

  return null;
}

export function buildMakerUserContentBlocks(
  text: string,
  mentions?: readonly MentionedResource[],
  files?: readonly SerializedAttachedFile[],
): SdkUserContentBlock[] {
  const blocks: SdkUserContentBlock[] = [];
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }

  for (const mention of mentions ?? []) {
    blocks.push({
      type: 'mention',
      name: mention.name,
      path: mention.path,
      kind: mention.type,
    });
  }

  for (const file of files ?? []) {
    const block = buildAttachmentBlock(file);
    if (block) blocks.push(block);
  }

  return blocks;
}

export function buildMakerUserMessage(
  text: string,
  mentions?: readonly MentionedResource[],
  files?: readonly SerializedAttachedFile[],
): MakerUserMessage {
  const blocks = buildMakerUserContentBlocks(text, mentions, files);
  const firstBlock = blocks[0];
  if (blocks.length === 1 && firstBlock?.type === 'text') {
    return { type: 'user', content: firstBlock.text };
  }
  return { type: 'user', content: blocks };
}
