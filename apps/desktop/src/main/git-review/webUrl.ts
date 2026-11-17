import type { runGit } from './gitRunner.js';

type WebProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitee' | 'gitea' | 'azure' | 'unknown';

interface WebRepo {
  baseUrl: string;
  provider: WebProvider;
}

function providerFor(hostname: string): WebProvider {
  const host = hostname.toLowerCase();
  if (host === 'github.com' || host.startsWith('github.') || host.includes('.github.'))
    return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.') || host.includes('.gitlab.'))
    return 'gitlab';
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) return 'bitbucket';
  if (host === 'gitee.com' || host.endsWith('.gitee.com')) return 'gitee';
  if (host === 'codeberg.org' || host.startsWith('gitea.') || host.startsWith('forgejo.'))
    return 'gitea';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure';
  return 'unknown';
}

function stripRepoPath(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '');
}

function webRepoFromRemote(remoteUrl: string): WebRepo | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  const scp = /^[^@\s]+@([^:/\s]+):(.+)$/.exec(raw);
  if (scp) {
    const repoPath = stripRepoPath(scp[2]).replace(/^\/+/, '');
    if (!repoPath) return null;
    return {
      baseUrl: `https://${scp[1]}/${repoPath}`,
      provider: providerFor(scp[1]),
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'ssh:' &&
    url.protocol !== 'git:' &&
    url.protocol !== 'git+ssh:'
  ) {
    return null;
  }
  const repoPath = stripRepoPath(url.pathname);
  if (!repoPath || repoPath === '/') return null;
  const protocol = url.protocol === 'http:' ? 'http:' : 'https:';
  const host =
    url.protocol === 'ssh:' || url.protocol === 'git:' || url.protocol === 'git+ssh:'
      ? url.hostname
      : url.host;
  return {
    baseUrl: `${protocol}//${host}${repoPath}`,
    provider: providerFor(url.hostname),
  };
}

function encodeBranchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** Build a browser page for the branch without exposing remote credentials. */
export function buildReviewBranchWebUrl(remoteUrl: string, branch: string): string | null {
  if (!branch) return null;
  const repo = webRepoFromRemote(remoteUrl);
  if (!repo) return null;
  const encodedBranch = encodeBranchPath(branch);
  switch (repo.provider) {
    case 'github':
    case 'gitee':
      return `${repo.baseUrl}/tree/${encodedBranch}`;
    case 'gitlab':
      return `${repo.baseUrl}/-/tree/${encodedBranch}`;
    case 'bitbucket':
      return `${repo.baseUrl}/src/${encodedBranch}`;
    case 'gitea':
      return `${repo.baseUrl}/src/branch/${encodedBranch}`;
    case 'azure':
      return repo.baseUrl.includes('/_git/')
        ? `${repo.baseUrl}?version=GB${encodeURIComponent(branch)}`
        : repo.baseUrl;
    default:
      return repo.baseUrl;
  }
}

async function readConfig(
  repoRoot: string,
  key: string,
  git: typeof runGit,
): Promise<string | null> {
  try {
    const { stdout } = await git(['config', '--get', key], { cwd: repoRoot });
    return stdout.split(/\r?\n/, 1)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export async function readReviewBranchWebUrl(
  repoRoot: string,
  branch: string | null,
  git: typeof runGit,
): Promise<string | null> {
  if (!branch) return null;
  try {
    // 推送端点与远端分支名都要跟实际推送一致：本地分支跟踪 origin/release 时，
    // 打开的是 release 而不是本地分支名（评审 #10979 P2）。push:remoteref 缺省回落到
    // 同名分支。
    const { stdout } = await git(
      [
        'for-each-ref',
        '--format=%(push:remotename)%00%(push:remoteref)',
        `refs/heads/${branch}`,
      ],
      { cwd: repoRoot },
    );
    const [remote = '', remoteRef = ''] = stdout.split(/\r?\n/, 1)[0]?.split('\0') ?? [];
    if (!remote) return null;
    const remoteUrl =
      (await readConfig(repoRoot, `remote.${remote}.pushurl`, git)) ??
      (await readConfig(repoRoot, `remote.${remote}.url`, git));
    const remoteBranch = remoteRef.startsWith('refs/heads/')
      ? remoteRef.slice('refs/heads/'.length)
      : branch;
    return remoteUrl ? buildReviewBranchWebUrl(remoteUrl, remoteBranch) : null;
  } catch {
    return null;
  }
}
