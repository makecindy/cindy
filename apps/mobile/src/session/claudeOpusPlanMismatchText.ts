import { i18n } from '@/i18n';
import { decodeClaudeOpusPlanMismatchReason } from '@cindy/maker-shared/claude-opus-plan-mismatch';

/** Stable request attribution -> localized Mobile copy; unknown reasons stay unmapped. */
export function claudeOpusPlanMismatchText(reason: unknown): string | null {
  const route = decodeClaudeOpusPlanMismatchReason(reason);
  if (route === 'gateway') {
    return i18n.t('message.systemCard.claudeGatewayOpusPlanMismatch');
  }
  if (route === 'subscription') {
    return i18n.t('message.systemCard.claudeSubscriptionOpusPlanMismatch');
  }
  return null;
}
