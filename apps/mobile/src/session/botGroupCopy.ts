import { formatRemoteError } from '@cindy/maker-shared/device-link-contract';
import { botGroupErrorVariant } from '@cindy/maker-shared/botGroupPresentation';
import { botGroupErrorCode } from './botGroupRemote';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * User-facing copy for a refused or failed group action: the host's own reason when it names
 * one the user can act on (PLAN_OPEN, MEMBER_LIMIT, …), otherwise the action's fallback line.
 */
export function botGroupActionErrorText(t: Translate, error: unknown, fallbackKey: string): string {
  const timeout = /\bINVOKE_TIMEOUT\b/.test(formatRemoteError(error));
  const variant = botGroupErrorVariant(timeout ? 'REQUEST_TIMEOUT' : botGroupErrorCode(error));
  return t(variant ? `groupChat.errors.${variant}` : fallbackKey);
}
