import { t } from '../i18n.js';

const MAX_REVIEW_SESSION_TITLE_LENGTH = 120;

export function buildReviewSessionTitle(sourceTitle: string): string {
  return t('review.sessionTitle')
    .replaceAll('{{title}}', sourceTitle)
    .slice(0, MAX_REVIEW_SESSION_TITLE_LENGTH);
}
