import { githubConnection } from './githubConnection.js';

/** Fixed Cindy repository operations; credentials and response bodies never leave Main. */
export function createGithubStar(deps: {
  readToken(): Promise<string | null>;
  owner(): string | null;
  fetch: typeof fetch;
}) {
  async function request(method: 'GET' | 'PUT'): Promise<boolean | null> {
    const owner = deps.owner();
    if (!owner) return null;
    try {
      const token = await deps.readToken();
      if (owner !== deps.owner()) return null;
      if (!token) return null;
      // Having a saved token is not proof of a usable, signed-in GitHub account.
      // Reuse the existing login verifier, with the same credential as the Star request.
      if (method === 'GET') {
        const connection = await githubConnection({
          readGh: async () => token,
          readFallback: () => null,
          fetch: deps.fetch,
        });
        if (owner !== deps.owner() || connection.status !== 'connected') return null;
      }
      const response = await deps.fetch('https://api.github.com/user/starred/makecindy/cindy', {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (owner !== deps.owner()) return null;
      if (response.status === 204) return true;
      if (response.status === 404 && method === 'GET') return false;
      return null;
    } catch {
      return null;
    }
  }
  return { check: () => request('GET'), star: () => request('PUT') };
}
