import type { ReviewArtifactConfirmationItem } from './reviewArtifactAuthorization.js';

type Translate = (key: string) => string;

export interface ReviewArtifactConfirmItem {
  kind: 'external-path' | 'inline';
  label: string;
  path?: string;
  inlineLabel?: string;
}

export interface ReviewArtifactConfirmDialogModel {
  title: string;
  message: string;
  detail: string;
  items: ReviewArtifactConfirmItem[];
  allowText: string;
  cancelText: string;
}

function dialogLine(value: string, max = 600): string {
  return (
    value
      .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, ' ')
      .trim()
      .slice(0, max) || 'unnamed'
  );
}

/**
 * Main owns the consent copy and sanitizes every value before the isolated
 * Cindy consent window renders it. Every item remains visible and approval
 * requires an explicit click.
 */
export function buildReviewArtifactConfirmationDialog(
  items: readonly ReviewArtifactConfirmationItem[],
  translate: Translate,
): ReviewArtifactConfirmDialogModel {
  const dialogItems = items.map((item) => {
    const label = dialogLine(item.label);
    return item.kind === 'external-path'
      ? { kind: item.kind, label, path: dialogLine(item.path ?? '', 1_200) }
      : {
          kind: item.kind,
          label,
          inlineLabel: translate('review.externalArtifactConfirm.inline'),
        };
  });
  return {
    title: translate('review.externalArtifactConfirm.title'),
    message: translate('review.externalArtifactConfirm.message').replace(
      '{{count}}',
      String(items.length),
    ),
    detail: translate('review.externalArtifactConfirm.detail'),
    items: dialogItems,
    allowText: translate('review.externalArtifactConfirm.allow'),
    cancelText: translate('review.externalArtifactConfirm.cancel'),
  };
}
