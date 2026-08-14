import type { MessageBoxOptions } from 'electron';

import type { ReviewArtifactConfirmationItem } from './reviewArtifactAuthorization.js';

type Translate = (key: string) => string;

function dialogLine(value: string, max = 600): string {
  return (
    value
      .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, ' ')
      .trim()
      .slice(0, max) || 'unnamed'
  );
}

/**
 * Native consent is the final boundary before out-of-workspace bytes reach a
 * configured model. Every item remains visible and Cancel owns both Enter and
 * Escape so approval always requires an explicit click.
 */
export function buildReviewArtifactConfirmationDialog(
  items: readonly ReviewArtifactConfirmationItem[],
  translate: Translate,
): MessageBoxOptions {
  const lines = items.map((item) => {
    const label = dialogLine(item.label);
    return item.kind === 'external-path'
      ? `• ${label}\n  ${dialogLine(item.path ?? '', 1_200)}`
      : `• ${label} (${translate('review.externalArtifactConfirm.inline')})`;
  });
  return {
    type: 'warning',
    title: translate('review.externalArtifactConfirm.title'),
    message: translate('review.externalArtifactConfirm.message').replace(
      '{{count}}',
      String(items.length),
    ),
    detail: `${translate('review.externalArtifactConfirm.detail')}\n\n${lines.join('\n')}`,
    buttons: [
      translate('review.externalArtifactConfirm.cancel'),
      translate('review.externalArtifactConfirm.allow'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
