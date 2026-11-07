import type {
  NormalizedAttachment,
  NormalizedRemoteMessage,
  NormalizedToolDiff,
  NormalizedToolMedia,
} from '@/session/messageNormalize';
import {
  buildAttachmentPayload as buildSharedAttachmentPayload,
  buildDiffPayload as buildSharedDiffPayload,
  buildFilePayload as buildSharedFilePayload,
  buildMediaPayload as buildSharedMediaPayload,
  buildMermaidPayload as buildSharedMermaidPayload,
  buildPayloadToolDiff,
  buildTextPayload,
  extractPayloadToolResultMedia,
  formatPayloadToolUseSummary,
  formatDiffPayload as formatSharedDiffPayload,
  formatDiffPayloadRows as formatSharedDiffPayloadRows,
  formatDiffPayloadView as formatSharedDiffPayloadView,
  formatMediaActionNotice as formatSharedMediaActionNotice,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  payloadMediaKindLabel as sharedPayloadMediaKindLabel,
  summarizeMessagePayloadBody as summarizeSharedMessagePayloadBody,
  summarizeMessagePayloadPreview as summarizeSharedMessagePayloadPreview,
  summarizeMessagePayload as summarizeSharedMessagePayload,
  type FormattedDiffPayloadLine,
  type FormattedDiffPayloadRow,
  type FormattedDiffPayloadRowKind,
  type FormattedDiffPayloadSection,
  type FormattedDiffPayloadView,
  type MessagePayloadSummary,
  type MessagePayloadBodyPresentation,
  type MessagePayloadPreview,
  type MessagePayloadPreviewActionKind,
  type MessagePayloadPreviewOptions,
  type MessagePayloadPreviewSeverity,
  type PayloadAttachmentLike,
  type SharedMessagePayload,
} from '@cindy/maker-shared/payload-summary';
import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import type { ResolveRemoteMediaFn } from './remoteMedia';

export type MessagePayload = SharedMessagePayload<NormalizedToolDiff, NormalizedToolMedia> & {
  /** Mobile 查看器内的附件身份，不参与跨端传输；地址变化时仍能定位同一页。 */
  galleryImageKey?: string;
  /** 待发送图片条中的位置（含未就绪格），仅在打开前附件被替换、身份失效时兜底。 */
  galleryImageSlot?: number;
};

/** Direct media already has playable bytes; only host-owned references need fetching. */
export async function resolveAttachmentPreviewSource(
  payload: Extract<MessagePayload, { kind: 'file' | 'media' }>,
  resolve: ResolveRemoteMediaFn,
  signal: AbortSignal,
) {
  if (payload.kind === 'media' && payload.media.previewable && (isPayloadDirectPreviewableUrl(payload.media.url) || /^data:audio\//i.test(payload.media.url)))
    return { url: payload.media.url, mimeType: payload.media.mimeType };
  const source = payload.kind === 'file' ? payload.sourcePath! : payload.media.url;
  const url = /^(?:[a-z][a-z0-9+.-]*):/i.test(source)
    ? source
    : `xdt-file://open?path=${encodeURIComponent(source)}`;
  return resolve({ kind: 'file', url, previewable: false }, { front: true, signal });
}

export {
  buildPayloadToolDiff,
  buildTextPayload,
  extractPayloadToolResultMedia,
  formatPayloadToolUseSummary,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  type FormattedDiffPayloadLine,
  type FormattedDiffPayloadRow,
  type FormattedDiffPayloadRowKind,
  type FormattedDiffPayloadSection,
  type FormattedDiffPayloadView,
  type MessagePayloadSummary,
  type MessagePayloadBodyPresentation,
  type MessagePayloadPreview,
  type MessagePayloadPreviewActionKind,
  type MessagePayloadPreviewOptions,
  type MessagePayloadPreviewSeverity,
  type PayloadAttachmentLike,
};

export function buildToolResultPayload(tool: NormalizedRemoteMessage): MessagePayload | null {
  if (!tool.secondaryBody) return null;
  return buildTextPayload(i18n.t('message.renderer.toolOutputTitle', { label: tool.label || 'tool' }), tool.secondaryBody);
}

export function buildDiffPayload(diff: NormalizedToolDiff): MessagePayload {
  return buildSharedDiffPayload(diff, mobilePresentationLocalizer);
}

export function buildMediaPayload(
  media: NormalizedToolMedia,
  label: string,
): Extract<MessagePayload, { kind: 'media' }> {
  return buildSharedMediaPayload(media, label, mobilePresentationLocalizer);
}

export function buildAttachmentPayload(attachment: NormalizedAttachment): MessagePayload {
  const payload = buildSharedAttachmentPayload(attachment, mobilePresentationLocalizer);
  if (payload.kind === 'media' && attachment.mimeType) {
    return { ...payload, media: { ...payload.media, mimeType: attachment.mimeType } };
  }
  return payload;
}

export function buildFilePayload(title: string, sourcePath: string): Extract<MessagePayload, { kind: 'file' }> {
  return buildSharedFilePayload(title, sourcePath, mobilePresentationLocalizer);
}

export function buildMermaidPayload(source: string): Extract<MessagePayload, { kind: 'mermaid' }> {
  return buildSharedMermaidPayload(source, mobilePresentationLocalizer);
}

export function summarizeMessagePayload(payload: MessagePayload): MessagePayloadSummary {
  return summarizeSharedMessagePayload(payload, mobilePresentationLocalizer);
}

export function summarizeMessagePayloadBody(payload: MessagePayload): MessagePayloadBodyPresentation {
  return summarizeSharedMessagePayloadBody(payload, mobilePresentationLocalizer);
}

export function summarizeMessagePayloadPreview(
  payload: MessagePayload,
  options: MessagePayloadPreviewOptions = {},
): MessagePayloadPreview {
  return summarizeSharedMessagePayloadPreview(payload, options, mobilePresentationLocalizer);
}

export function payloadMediaKindLabel(kind: NormalizedToolMedia['kind']): string {
  return sharedPayloadMediaKindLabel(kind, mobilePresentationLocalizer);
}

export function formatDiffPayload(diff: NormalizedToolDiff): string {
  return formatSharedDiffPayload(diff, mobilePresentationLocalizer);
}

export function formatDiffPayloadRows(diff: NormalizedToolDiff): FormattedDiffPayloadRow[] {
  return formatSharedDiffPayloadRows(diff, mobilePresentationLocalizer);
}

export function formatDiffPayloadView(diff: NormalizedToolDiff): FormattedDiffPayloadView {
  return formatSharedDiffPayloadView(diff, mobilePresentationLocalizer);
}

export function formatMediaActionNotice(media: NormalizedToolMedia): string {
  return formatSharedMediaActionNotice(media, mobilePresentationLocalizer);
}
