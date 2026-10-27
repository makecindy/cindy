interface ChatgptIdTokenClaims {
  chatgpt_account_id?: unknown;
  sub?: unknown;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
}

export function readChatgptIdTokenClaims(idToken: string): ChatgptIdTokenClaims | null {
  try {
    const part = idToken.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as ChatgptIdTokenClaims;
  } catch {
    return null;
  }
}

/** Workspace identity for reconciliation/recovery; JWT sub cannot identify a workspace. */
export function codexWorkspaceIdFromTokens(
  tokens: { account_id?: unknown; id_token?: unknown } | undefined,
): string | null {
  if (typeof tokens?.account_id === 'string' && tokens.account_id.length > 0) {
    return tokens.account_id;
  }
  const claims = typeof tokens?.id_token === 'string' ? readChatgptIdTokenClaims(tokens.id_token) : null;
  const nested = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  const topLevel = claims?.chatgpt_account_id;
  return typeof topLevel === 'string' && topLevel.length > 0 ? topLevel : null;
}
