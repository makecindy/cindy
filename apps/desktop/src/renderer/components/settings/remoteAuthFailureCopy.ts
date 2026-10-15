/**
 * Localized copy for SSH auth failures (#4201).
 *
 * Main keeps the canonical English hint in `lastError` (logs, failure
 * classification, cindy_ssh MCP hint) and also projects the structured
 * `authFailure`; the host row subtitle and the connect-failure toast render
 * this localized form instead. Shell commands, identity labels and the ssh2
 * cause are interpolated verbatim — commands stay English by design.
 */
type AuthFailureDetail = NonNullable<RemoteHostSnapshot['authFailure']>;
type Translate = (key: string, options?: Record<string, unknown>) => string;

const MESSAGE_KEYS: Record<AuthFailureDetail['kind'], string> = {
  'agent-not-loaded': 'settings.remote.authFailure.agentNotLoaded',
  'agent-sign-failed': 'settings.remote.authFailure.agentSignFailed',
  'agent-signed-not-accepted': 'settings.remote.authFailure.agentSignedNotAccepted',
  'agent-pinned': 'settings.remote.authFailure.agentPinned',
  'agent-unpinned': 'settings.remote.authFailure.agentUnpinned',
  'key-rejected': 'settings.remote.authFailure.keyRejected',
  generic: 'settings.remote.authFailure.generic',
};

export function formatRemoteAuthFailure(t: Translate, detail: AuthFailureDetail): string {
  // The list separator is locale copy too (zh / ja use 「、」), so it comes
  // from the catalog instead of a pre-joined English string.
  const identities = detail.identities.join(t('settings.remote.authFailure.identitySeparator'));
  const identitySet = identities
    ? t('settings.remote.authFailure.identitySet', { identities })
    : '';
  const message = t(MESSAGE_KEYS[detail.kind] ?? MESSAGE_KEYS.generic, {
    target: `${detail.user}@${detail.hostname}`,
    identitySet,
    command: detail.command ?? '',
  });
  const cause = detail.cause?.trim();
  return cause ? `${message}${t('settings.remote.authFailure.cause', { cause })}` : message;
}
