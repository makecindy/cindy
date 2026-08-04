/**
 * Remove trailing /goal protocol blocks that are stored in assistant messages
 * but intentionally omitted from the rendered conversation.
 */
const TRAILING_FENCED_BLOCK = /\n?\s*```(?:json|jsonc)?\s*\{[^{}]*"goal_(?:status|setup)"[^{}]*\}\s*```\s*$/i;
const TRAILING_BARE_BLOCK = /\n?\s*\{[^{}]*"goal_(?:status|setup)"[^{}]*\}\s*$/i;

export function stripGoalVerdictBlock(content: string): string {
  if (
    !content ||
    typeof content !== 'string' ||
    (!content.includes('goal_status') && !content.includes('goal_setup'))
  ) {
    return content;
  }
  if (TRAILING_FENCED_BLOCK.test(content)) {
    return content.replace(TRAILING_FENCED_BLOCK, '').trimEnd();
  }
  if (TRAILING_BARE_BLOCK.test(content)) {
    return content.replace(TRAILING_BARE_BLOCK, '').trimEnd();
  }
  return content;
}
