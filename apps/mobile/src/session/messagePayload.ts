import type {
  NormalizedAttachment,
  NormalizedRemoteMessage,
  NormalizedToolDiff,
  NormalizedToolMedia,
} from '@/session/messageNormalize';
import {
  buildAttachmentPayload as buildSharedAttachmentPayload,
  buildDiffPayload as buildSharedDiffPayload,
  buildFilePayload,
  buildMediaPayload as buildSharedMediaPayload,
  buildMermaidPayload,
  buildPayloadToolDiff,
  buildTextPayload,
  extractPayloadToolResultMedia,
  formatPayloadToolUseSummary,
  formatDiffPayload,
  formatDiffPayloadRows,
  formatDiffPayloadView,
  formatMediaActionNotice,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  payloadMediaKindLabel,
  summarizeMessagePayloadBody,
  summarizeMessagePayloadPreview,
  summarizeMessagePayload,
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

export type MessagePayload = SharedMessagePayload<NormalizedToolDiff, NormalizedToolMedia>;

export {
  buildFilePayload,
  buildMermaidPayload,
  buildPayloadToolDiff,
  buildTextPayload,
  extractPayloadToolResultMedia,
  formatDiffPayload,
  formatDiffPayloadRows,
  formatDiffPayloadView,
  formatMediaActionNotice,
  formatPayloadToolUseSummary,
  isPayloadDesktopLocalMediaUrl,
  isPayloadDirectPreviewableUrl,
  payloadMediaKindLabel,
  summarizeMessagePayloadBody,
  summarizeMessagePayloadPreview,
  summarizeMessagePayload,
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
  return buildSharedDiffPayload(diff);
}

export function buildMediaPayload(
  media: NormalizedToolMedia,
  label: string,
): Extract<MessagePayload, { kind: 'media' }> {
  return buildSharedMediaPayload(media, label);
}

export function buildAttachmentPayload(attachment: NormalizedAttachment): MessagePayload {
  return buildSharedAttachmentPayload(attachment);
}
