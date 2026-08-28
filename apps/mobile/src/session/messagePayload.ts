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

export type MessagePayload = SharedMessagePayload<NormalizedToolDiff, NormalizedToolMedia>;

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
  return buildSharedAttachmentPayload(attachment, mobilePresentationLocalizer);
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
