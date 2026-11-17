/** Main-only OAuth material. Never use this type in renderer/device-link contracts. */
export interface GithubUserGrant {
  userId: string;
  login: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/** Opaque server-sealed rotated pair; GitHub already spent the previous refresh token. */
export type GithubRefreshCredential = { refreshToken: string } | { recovery: string };
const isRecovery = (value: unknown): value is { recovery: string } => !!value && typeof value === 'object'
  && typeof (value as { recovery?: unknown }).recovery === 'string' && (value as { recovery: string }).recovery.length > 0
  && (value as { recovery: string }).recovery.length <= 24576;

export function isGithubUserGrant(value: unknown): value is GithubUserGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as GithubUserGrant;
  return typeof grant.userId === 'string' && /^[1-9]\d*$/.test(grant.userId)
    && typeof grant.login === 'string' && /^[a-z\d-]{1,39}$/i.test(grant.login)
    && [grant.accessToken, grant.refreshToken].every(token => typeof token === 'string' && token.length > 0 && token.length <= 8192)
    && Number.isSafeInteger(grant.expiresAt) && Number.isSafeInteger(grant.refreshExpiresAt);
}

/** Serialized encrypted IO, including rotated-token refresh, prevents a second process
 * from spending the same refresh token or restoring credentials after disconnect. */
export function createGithubAppAuthorization(deps: {
  scope(): string;
  read(): string | null;
  write(value: string): boolean;
  remove(): boolean;
  lock<T>(work: () => Promise<T>): Promise<T>;
  refresh(credential: GithubRefreshCredential): Promise<unknown>;
  changed(): void;
  now(): number;
}) {
  let pending: { scope: string; promise: Promise<string | null> } | undefined;
  const current = (scope: string) => { if (scope !== deps.scope()) throw new Error('GITHUB_ACCOUNT_CHANGED'); };
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const scope = deps.scope();
    return deps.lock(async () => { current(scope); return work(); });
  };
  return {
    save(value: unknown): Promise<void> {
      pending = undefined;
      return serialized(async () => {
        if (!isGithubUserGrant(value) || value.expiresAt <= deps.now() || value.refreshExpiresAt <= deps.now()) {
          throw new Error('GITHUB_INVALID_USER_GRANT');
        }
        if (!deps.write(JSON.stringify(value))) throw new Error('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
        deps.changed();
      });
    },
    clear(): Promise<void> {
      pending = undefined;
      return serialized(async () => {
        if (!deps.remove()) throw new Error('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
        deps.changed();
      });
    },
    readToken(): Promise<string | null> {
      const requestScope = deps.scope();
      if (pending?.scope === requestScope) return pending.promise;
      const promise = serialized(async () => {
        const scope = deps.scope();
        const raw = deps.read();
        if (!raw) return null;
        let stored: unknown;
        try { stored = JSON.parse(raw); } catch { throw new Error('GITHUB_INVALID_USER_GRANT'); }
        if (!isGithubUserGrant(stored)) throw new Error('GITHUB_INVALID_USER_GRANT');
        if (stored.expiresAt > deps.now() + 120_000) return stored.accessToken;
        if (stored.refreshExpiresAt <= deps.now()) return null;
        const recovery = (stored as { recovery?: unknown }).recovery;
        let renewed: unknown;
        try { renewed = await deps.refresh(isRecovery({ recovery }) ? { recovery: recovery as string } : { refreshToken: stored.refreshToken }); }
        catch { throw new Error('GITHUB_AUTHORIZATION_REFRESH_FAILED'); }
        current(scope);
        if (isRecovery(renewed)) {
          // Keep the sealed pair before reporting a temporary failure; the old refresh token is no longer valid.
          if (!deps.write(JSON.stringify({ ...stored, recovery: renewed.recovery }))) throw new Error('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
          throw new Error('GITHUB_AUTHORIZATION_REFRESH_FAILED');
        }
        if (renewed === null) {
          if (!deps.remove()) throw new Error('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
          deps.changed();
          return null;
        }
        if (!isGithubUserGrant(renewed) || renewed.userId !== stored.userId
          || renewed.expiresAt <= deps.now() || renewed.refreshExpiresAt <= deps.now()) throw new Error('GITHUB_INVALID_USER_GRANT');
        if (!deps.write(JSON.stringify(renewed))) throw new Error('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
        return renewed.accessToken;
      });
      pending = { scope: requestScope, promise };
      const finished = () => { if (pending?.promise === promise) pending = undefined; };
      void promise.then(finished, finished);
      return promise;
    },
  };
}
