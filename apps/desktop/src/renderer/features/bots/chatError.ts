const key = (name: string) => `bots.groupChat.server.${name}`;

export function chatErrorKey(code: string) {
  if (code === 'INVITE_REVOKE_UNSUPPORTED') return key('revokeUnsupported');
  if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE', 'INVALID_INPUT'].includes(code)) return key('invalidInvite');
  if (code === 'ALL_BOTS_MENTION_DISABLED') return 'bots.groupChat.errors.allBotsMentionDisabled';
  if (code === 'MENTION_UNAVAILABLE') return 'bots.groupChat.errors.mentionUnavailable';
  if (code === 'SHARE_UNAVAILABLE') return key('thread.shareUnavailable');
  if (code === 'LIFECYCLE_UNAVAILABLE') return 'bots.groupChat.lifecycle.unavailable';
  if (['GROUP_DISSOLVED', 'CONVERSATION_DISSOLVED'].includes(code)) return 'bots.groupChat.lifecycle.dissolved';
  if (code === 'LAST_OWNER') return key('settings.lastOwner');
  if (code === 'REVISION_CONFLICT') return key('settings.conflict');
  if (['FORBIDDEN', 'ROLE_REQUIRED', 'OWNER_REQUIRED', 'HUMAN_OWNER_REQUIRED', 'BOT_OWNER_NOT_IN_GROUP', 'ACTOR_NOT_OWNED', 'IDENTITY_DOMAIN_MISMATCH'].includes(code)) return key('notAllowed');
  if (['AUTH_REQUIRED', 'OWNER_CHANGED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(code)) return key('loginRequired');
  return key('requestFailed');
}
