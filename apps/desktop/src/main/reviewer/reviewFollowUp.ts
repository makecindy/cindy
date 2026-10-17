import { t } from '../i18n.js';
import {
  followUpReplyLanguageInstruction,
  type ReviewReplyLanguage,
} from './reviewReplyLanguage.js';

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );

const MAX_FOCUS_CHARS = 200;
const MAX_FOLLOW_UP_RESULT_CHARS = 24_000;

/**
 * What the Reviewer task shows as its first message. The model receives the
 * full evidence prompt; people only need to know what was reviewed.
 */
export function buildReviewInputSummary(input: {
  workingDir?: string;
  baseRef?: string;
  hasUncommittedChanges?: boolean;
  additionalWorkingDirs?: readonly string[];
  /** Repositories the task touched that this review could not include. */
  uncoveredWorkingDirs?: readonly string[];
  uncheckedTaskDirs?: number;
  artifactCount: number;
  focus?: string;
}): string {
  const lines = [t('review.inputSummary.title')];
  if (input.workingDir) {
    const details = [
      input.baseRef ? fill(t('review.inputSummary.baseline'), { base: input.baseRef }) : '',
      input.hasUncommittedChanges ? t('review.inputSummary.uncommitted') : '',
    ].filter(Boolean);
    lines.push(
      [fill(t('review.inputSummary.directory'), { dir: input.workingDir }), ...details].join(' · '),
    );
  } else {
    lines.push(t('review.inputSummary.task'));
  }
  if (input.additionalWorkingDirs?.length) {
    lines.push(
      fill(t('review.inputSummary.additionalDirectories'), {
        dirs: input.additionalWorkingDirs.join(', '),
      }),
    );
  }
  if (input.uncoveredWorkingDirs?.length) {
    lines.push(
      fill(t('review.inputSummary.uncovered'), { dirs: input.uncoveredWorkingDirs.join(', ') }),
    );
  }
  if ((input.uncheckedTaskDirs ?? 0) > 0) {
    lines.push(
      fill(t('review.inputSummary.uncheckedDirs'), { count: String(input.uncheckedTaskDirs) }),
    );
  }
  if (input.artifactCount > 0) {
    lines.push(fill(t('review.inputSummary.artifacts'), { count: String(input.artifactCount) }));
  }
  const focus = input.focus?.replace(/\s+/g, ' ').trim();
  if (focus) {
    lines.push(
      fill(t('review.inputSummary.focus'), {
        focus: focus.length > MAX_FOCUS_CHARS ? `${focus.slice(0, MAX_FOCUS_CHARS)}…` : focus,
      }),
    );
  }
  return lines.join('\n');
}

/**
 * Model input for the source task's follow-up turn. It is a hidden host input:
 * the user already sees the conclusion in the review card, so nothing else is
 * shown. The note is written in English and names the language detected from
 * the user's own messages, so neither the note nor a review written in another
 * language pulls a Japanese or Korean task into it. The Reviewer can be wrong, so the source agent verifies
 * every finding against the current code before changing anything.
 */
export function buildReviewFollowUpMessage(
  result: string,
  replyLanguage: ReviewReplyLanguage | null = null,
): string {
  const clipped =
    result.length > MAX_FOLLOW_UP_RESULT_CHARS
      ? `${result.slice(0, MAX_FOLLOW_UP_RESULT_CHARS)}\n… (review result truncated; the full text is in the review card)`
      : result;
  return [
    '[Review result] This is not a message typed by the user. The user ran /review; an independent, read-only reviewer with no development memory returned the conclusion below, which the user already sees in the review card.',
    'The reviewer can be wrong. Verify each finding against the current code. Fix the findings that hold and verify the fixes; for false positives, explain why instead of changing correct code. Then briefly report how each finding was handled.',
    followUpReplyLanguageInstruction(replyLanguage),
    '',
    '<review-result>',
    clipped.replace(/<\/?review-result>/gi, (tag) => tag.replace('<', '&lt;').replace('>', '&gt;')),
    '</review-result>',
  ].join('\n');
}
