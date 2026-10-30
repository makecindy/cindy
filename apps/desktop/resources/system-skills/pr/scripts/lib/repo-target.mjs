import { execFileSync } from 'node:child_process';

/** Parse an owner/name pair from a GitHub remote URL. */
export function parseGitHubRemote(url) {
  const normalized = String(url || '').trim().replace(/\.git$/, '');
  const match = normalized.match(/github\.com(?::|\/)([^/:\s]+)\/([^/\s]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Parse repository identity and PR number from a full GitHub pull request URL. */
export function parsePullRequestUrl(value) {
  const match = String(value || '').match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
  );
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

function repoFromWorktree(worktree) {
  try {
    const remote = execFileSync('git', ['-C', worktree, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

/**
 * Resolve a PR target without a repository default.
 *
 * Precedence: explicit --repo, full PR URL, then the worktree's origin. A URL
 * and explicit repo must agree so overlapping PR numbers cannot hit the wrong
 * repository silently.
 */
export function resolvePullRequestTarget(prArg, { explicitRepo = null, worktree = process.cwd() } = {}) {
  if (!prArg) throw new Error('Missing PR number or URL');

  const fromUrl = parsePullRequestUrl(prArg);
  if (String(prArg).includes('://') && !fromUrl) {
    throw new Error(`Unsupported GitHub PR URL: ${prArg}`);
  }
  const numberMatch = String(prArg).match(/(?:pull\/)?(\d+)(?:[/?#].*)?$/);
  if (!numberMatch) throw new Error(`Cannot parse PR number from: ${prArg}`);

  if (explicitRepo && fromUrl && explicitRepo.toLowerCase() !== fromUrl.repo.toLowerCase()) {
    throw new Error(`PR URL repo ${fromUrl.repo} does not match --repo ${explicitRepo}`);
  }

  const repo = explicitRepo || fromUrl?.repo || repoFromWorktree(worktree);
  if (!repo) {
    throw new Error(
      'Cannot resolve GitHub repository. Use a full PR URL, run inside the target worktree, or pass --repo owner/name.',
    );
  }
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`Invalid repo, expected owner/name: ${repo}`);
  }

  return {
    repo,
    owner: parts[0],
    name: parts[1],
    number: fromUrl?.number ?? Number(numberMatch[1]),
  };
}
