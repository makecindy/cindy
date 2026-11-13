import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexWorkspaceIdFromTokens, readChatgptIdTokenClaims } from './codex-auth-identity.js';

export function chatgptAccountIdFromIdToken(idToken: string): string | null {
  const workspaceId = codexWorkspaceIdFromTokens({ id_token: idToken });
  if (workspaceId) return workspaceId;
  const sub = readChatgptIdTokenClaims(idToken)?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

/** HTTP header identity only; workspace/recovery checks must keep the strict parser. */
export function chatgptAccountIdFromTokens(
  tokens: { account_id?: unknown; id_token?: unknown } | undefined,
): string | null {
  if (typeof tokens?.account_id === 'string' && tokens.account_id.length > 0) return tokens.account_id;
  return typeof tokens?.id_token === 'string' ? chatgptAccountIdFromIdToken(tokens.id_token) : null;
}

export type CodexCredentialGeneration = {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  sha256: string;
};



export function currentCodexCredentialGeneration(authPath: string): CodexCredentialGeneration | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(authPath, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    return {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function captureCodexOAuthDispatchProof(options: {
  home: string; accessToken: string; accountId: string | null;
  authenticated(): boolean; authorization(): string | null;
}): (() => boolean) | null {
  const { home, accessToken, accountId, authenticated, authorization } = options;
  if (!authenticated()) return null;
    const authPath = path.join(home, 'auth.json');
    const credential = () => {
      const value = currentCodexCredentialGeneration(authPath);
      return value ? JSON.stringify(value) : null;
    };
    // Independent accounts authorize against their existing account record;
    // inherited OpenAI uses the native provider authorization record.
    const credentialGeneration = credential();
    const authorizationGeneration = authorization();
    if (!credentialGeneration || !authorizationGeneration || authorizationGeneration === 'null') return null;
    try {
      const raw = fs.readFileSync(authPath, 'utf8');
      const auth = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown } };
      if (auth.tokens?.access_token !== accessToken || chatgptAccountIdFromTokens(auth.tokens) !== accountId) return null;
    } catch {
      return null;
    }
    const isCurrent = () => authenticated()
      && credential() === credentialGeneration
      && authorization() === authorizationGeneration;
    return isCurrent() ? isCurrent : null;
}
