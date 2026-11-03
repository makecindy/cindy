import type { GithubConnectionState } from '../../shared/githubSetup.js';

/** Verify the effective credential without returning credentials or remote error bodies. */
export async function githubConnection(deps: {
  readGh(): Promise<string | null>;
  readFallback(): string | null;
  fetch: typeof fetch;
}): Promise<GithubConnectionState> {
  let source: 'gh-cli' | 'token' = 'gh-cli';
  try {
    let token = await deps.readGh();
    if (!token) {
      source = 'token';
      token = deps.readFallback();
    }
    if (!token) return { status: 'missing' };
    const response = await deps.fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status:
          response.status === 401 ? 'auth' : response.status === 403 ? 'forbidden' : 'network',
        source,
      };
    }
    const data = (await response.json()) as { login?: unknown };
    return typeof data.login === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(data.login)
      ? { status: 'connected', login: data.login, source }
      : { status: 'network', source };
  } catch {
    return { status: 'network', source };
  }
}
