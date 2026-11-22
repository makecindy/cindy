import { formatRemoteError } from '@cindy/maker-shared/device-link-contract';
import { botGroupErrorVariant } from '@cindy/maker-shared/botGroupPresentation';
import { botGroupErrorCode } from './botGroupRemote';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * User-facing copy for a refused or failed group action: the host's own reason when it names
 * one the user can act on (PLAN_OPEN, MEMBER_LIMIT, …), otherwise the action's fallback line.
 */
export function botGroupActionErrorText(t: Translate, error: unknown, fallbackKey: string): string {
  if (/\bCONVERSATION_DISSOLVED\b/.test(formatRemoteError(error))) return t('groupChat.lifecycle.dissolved');
  if (/\b(?:PRECONDITION_FAILED|REVISION_CONFLICT)\b/.test(formatRemoteError(error))) return t('groupChat.settings.conflict');
  if (/\bSTOP_OWNERSHIP_UNKNOWN\b/.test(formatRemoteError(error))) return t('groupChat.errors.stopOwnershipUnknown');
  if (/\bNOTHING_TO_STOP\b/.test(formatRemoteError(error))) return t('groupChat.errors.nothingToStop');
  if (/\b(?:ROLE_REQUIRED|FORBIDDEN)\b/.test(formatRemoteError(error))) return t('groupChat.errors.permissionDenied');
  const timeout = /\bINVOKE_TIMEOUT\b/.test(formatRemoteError(error));
  const variant = botGroupErrorVariant(timeout ? 'REQUEST_TIMEOUT' : botGroupErrorCode(error));
  return t(variant ? `groupChat.errors.${variant}` : fallbackKey);
}
