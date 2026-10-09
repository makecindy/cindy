import type { MessageSourceGroup } from '@cindy/maker-shared/message-source';
import { t } from '../i18n.js';

/** A group link identifies a lane, not an authorization. Only its live Chat Server
 * execution may supply authority; persisted route keys cannot recreate a grant. */
export type GroupToolOperation = 'read-self' | 'owner-action';
export interface GroupToolAuthority {
  botId: string;
  sourceGroup?: MessageSourceGroup;
  mode: 'owner' | 'chat' | 'tools';
  validate(): Promise<void>;
  isCurrent(): boolean;
}
const authorities = new Map<string, GroupToolAuthority>();

export class GroupToolAuthorizationError extends Error {
  readonly code: string;
  constructor(readonly temporary = false) {
    super(t(temporary ? 'groupTools.verificationUnavailable' : 'groupTools.authorizationRequired'));
    this.code = temporary ? 'GROUP_AUTHORIZATION_UNAVAILABLE' : 'GROUP_AUTHORIZATION_REQUIRED';
  }
}

export function registerGroupToolAuthority(sessionId: string, authority: GroupToolAuthority): () => void {
  authorities.set(sessionId, authority);
  return () => { if (authorities.get(sessionId) === authority) authorities.delete(sessionId); };
}

export async function authorizeGroupTool(sessionId: string, botId: string, operation: GroupToolOperation) {
  const authority = authorities.get(sessionId);
  const assertCurrent = () => {
    if (!authority || authorities.get(sessionId) !== authority || authority.botId !== botId
      || !authority.isCurrent() || authority.mode === 'chat'
      || (operation === 'owner-action' && authority.mode !== 'owner')) throw new GroupToolAuthorizationError();
  };
  assertCurrent();
  try { await authority!.validate(); } catch (error) {
    const revoked = error instanceof GroupToolAuthorizationError && !error.temporary;
    if (revoked && authorities.get(sessionId) === authority) authorities.delete(sessionId);
    // A transport failure denies this attempt, without permanently revoking a live lease.
    assertCurrent();
    throw new GroupToolAuthorizationError(!revoked);
  }
  assertCurrent();
  return { assertCurrent, mode: authority!.mode, sourceGroup: authority!.sourceGroup, refresh: async (): Promise<void> => {
    assertCurrent();
    await authorizeGroupTool(sessionId, botId, operation);
    assertCurrent();
  } };
}
