const key = (name: string) => `bots.groupChat.server.${name}`;

export function chatErrorKey(code: string) {
  if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE', 'INVALID_INPUT'].includes(code)) return key('invalidInvite');
  if (code === 'LAST_OWNER') return key('settings.lastOwner');
  if (code === 'REVISION_CONFLICT') return key('settings.conflict');
  if (['FORBIDDEN', 'ROLE_REQUIRED', 'OWNER_REQUIRED', 'ACTOR_NOT_OWNED', 'IDENTITY_DOMAIN_MISMATCH'].includes(code)) return key('notAllowed');
  if (['AUTH_REQUIRED', 'OWNER_CHANGED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(code)) return key('loginRequired');
  return key('requestFailed');
}
