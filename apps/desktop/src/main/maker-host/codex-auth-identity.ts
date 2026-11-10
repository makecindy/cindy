import { createHash } from 'node:crypto';
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



export interface AccountIdentity {
  principal: string;
  label: string;
}


/** Pure parser: never return tokens through account status or IPC. */
export function parseCodexAccountIdentity(raw: string): AccountIdentity | null {
  try {
    const value = JSON.parse(raw);
    if (typeof value.tokens?.access_token !== 'string' || !value.tokens.access_token) return null;
    const jwt = value.tokens.id_token ?? value.tokens.access_token;
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const account =
      value.tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
    const subject = claims.sub;
    if (typeof account !== 'string' || typeof subject !== 'string') return null;
    return {
      principal: createHash('sha256').update(`${subject}\0${account}`).digest('hex'),
      label:
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.name === 'string'
            ? claims.name
            : 'ChatGPT',
    };
  } catch {
    return null;
  }
}