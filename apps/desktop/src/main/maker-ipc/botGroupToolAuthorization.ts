import { t } from '../i18n.js';
import { createGroupToolAuthorization, GroupToolAuthorizationError as BaseError } from '@cindy/app-runtime/botGroupToolAuthorization';
export type { GroupToolOperation, GroupToolAuthority } from '@cindy/app-runtime/botGroupToolAuthorization';
export class GroupToolAuthorizationError extends BaseError {
  constructor(temporary = false) { super(temporary, t(temporary ? 'groupTools.verificationUnavailable' : 'groupTools.authorizationRequired')); }
}
export const { registerGroupToolAuthority, authorizeGroupTool } = createGroupToolAuthorization({ error: temporary => new GroupToolAuthorizationError(temporary) });
