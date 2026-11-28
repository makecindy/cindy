import type { GithubAppAccess, GithubInstallationAccess } from '../../shared/githubSetup.js';

interface Installation {
  id: number;
  account: { login?: string; slug?: string };
  app_slug: string;
  repository_selection: 'all' | 'selected';
  suspended_at: string | null;
  permissions: Record<string, string>;
}

export async function githubInstallationAccess(
  readToken: () => Promise<string | null>,
  fetch: typeof globalThis.fetch,
  isCurrent: () => boolean,
): Promise<GithubAppAccess> {
  try {
    const token = await readToken();
    if (!token) return { status: 'missing' };
    const get = async (path: string) => {
      if (!isCurrent()) throw new Error('Account changed');
      const response = await fetch('https://api.github.com' + path, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('GitHub access unavailable');
      }
      return response.json();
    };
    const installations = new Map<number, GithubInstallationAccess>();
    for (let page = 1; ; page++) {
      const data = await get('/user/installations?per_page=100&page=' + page);
      if (!Array.isArray(data.installations)) throw new Error('Invalid installation list');
      for (const item of data.installations as Installation[]) {
        const owner = item.account?.login ?? item.account?.slug;
        if (!Number.isSafeInteger(item.id) || !owner || !item.app_slug ||
            !['all', 'selected'].includes(item.repository_selection) || !item.permissions) {
          throw new Error('Invalid installation');
        }
        installations.set(item.id, { id: item.id, owner, app: item.app_slug, selection: item.repository_selection,
          suspended: Boolean(item.suspended_at), permissions: item.permissions, visibleRepositories: null });
      }
      if (data.installations.length < 100) break;
    }
    for (const item of installations.values()) {
      if (!isCurrent()) return { status: 'unavailable' };
      if (item.suspended) continue;
      // total_count is sufficient; never download or forward a repository inventory.
      const count = await get('/user/installations/' + item.id + '/repositories?per_page=1')
        .then(data => data.total_count).catch(() => null);
      if (Number.isSafeInteger(count) && count >= 0) item.visibleRepositories = count;
    }
    if (isCurrent()) return { status: 'ready', installations: [...installations.values()] };
  } catch { /* Network, credential and response failures must not look like zero access. */ }
  return { status: 'unavailable' };
}
