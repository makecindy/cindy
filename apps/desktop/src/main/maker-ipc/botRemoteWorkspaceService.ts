import { ensureRemoteHostReady, getRemoteSshPool } from '../remote-ssh/index.js';

export interface RemoteBotWorktreeMeta {
  path: string;
  baseRepo: string;
  branch: string;
  sourceBranch: string;
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function shellBase64(value: string): string {
  const value64 = encoded(value);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value64)) {
    throw new Error('Bot remote workspace argument encoding failed');
  }
  return `'${value64}'`;
}

function decodeLine(value: string | undefined, field: string): string {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Bot remote workspace returned an invalid ${field}`);
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

async function readyHost(remoteHostId: string) {
  await ensureRemoteHostReady(remoteHostId);
  const host = getRemoteSshPool().get(remoteHostId);
  if (!host || host.getStatus() !== 'ready') {
    throw new Error(`Remote Bot workspace host is unavailable: ${remoteHostId}`);
  }
  return host;
}

const CREATE_SCRIPT = String.raw`
set -euo pipefail
decode() { node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$1"; }
encode() { node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' "$1"; }
base_repo="$(decode "$1")"
source_branch="$(decode "$2")"
slug="$(decode "$3")"
repo="$(git -C "$base_repo" rev-parse --show-toplevel)"
source_ref="\${source_branch:-HEAD}"
commit="$(git -C "$repo" rev-parse --verify "\${source_ref}^{commit}")"
worktree_root="$repo/.cindy-worktrees"
worktree_path="$worktree_root/$slug"
branch="cindy/bot-$slug"
mkdir -p "$worktree_root"
if [ -e "$worktree_path" ]; then
  actual="$(git -C "$worktree_path" rev-parse --show-toplevel)"
  [ "$actual" = "$worktree_path" ] || {
    printf '%s\n' 'existing remote path is not the expected worktree' >&2
    exit 23
  }
  actual_common="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-common-dir)"
  repo_common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
  [ "$actual_common" = "$repo_common" ] || {
    printf '%s\n' 'existing remote worktree belongs to another repository' >&2
    exit 24
  }
  actual_branch="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD || true)"
  [ "$actual_branch" = "$branch" ] || {
    printf '%s\n' 'existing remote worktree is on an unexpected branch' >&2
    exit 25
  }
else
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$worktree_path" "$branch" >&2
  else
    git -C "$repo" worktree add -b "$branch" "$worktree_path" "$commit" >&2
  fi
fi
printf '%s\n' "$(encode "$worktree_path")"
printf '%s\n' "$(encode "$repo")"
printf '%s\n' "$(encode "$branch")"
printf '%s\n' "$(encode "$source_ref")"
`;

const INSPECT_SCRIPT = String.raw`
set -euo pipefail
decode() { node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$1"; }
encode() { node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' "$1"; }
worktree_path="$(decode "$1")"
expected_repo="$(decode "$2")"
expected_branch="$(decode "$3")"
[ ! -e "$worktree_path" ] && exit 44
[ -d "$worktree_path" ] || exit 45
actual="$(git -C "$worktree_path" rev-parse --show-toplevel)"
[ "$actual" = "$worktree_path" ] || exit 46
actual_common="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-common-dir)"
repo="$(git -C "$expected_repo" rev-parse --show-toplevel)"
repo_common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
[ "$actual_common" = "$repo_common" ] || exit 47
branch="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD || true)"
[ -z "$expected_branch" ] || [ "$branch" = "$expected_branch" ] || exit 48
printf '%s\n' "$(encode "$actual")"
printf '%s\n' "$(encode "$branch")"
`;

const REMOVE_SCRIPT = String.raw`
set -euo pipefail
decode() { node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$1"; }
base_repo="$(decode "$1")"
worktree_path="$(decode "$2")"
expected_branch="$(decode "$3")"
repo="$(git -C "$base_repo" rev-parse --show-toplevel)"
[ ! -e "$worktree_path" ] && exit 0
[ ! -e "$worktree_path/.worktree-keep" ] || {
  printf '%s\n' 'remote worktree has a .worktree-keep protection marker' >&2
  exit 61
}
actual="$(git -C "$worktree_path" rev-parse --show-toplevel)"
[ "$actual" = "$worktree_path" ] || exit 62
actual_common="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-common-dir)"
repo_common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
[ "$actual_common" = "$repo_common" ] || exit 63
branch="$(git -C "$worktree_path" symbolic-ref --quiet --short HEAD || true)"
[ -n "$expected_branch" ] && [ "$branch" = "$expected_branch" ] || exit 64
git -C "$repo" worktree remove "$worktree_path"
[ ! -e "$worktree_path" ]
`;

export async function createRemoteBotWorktree(input: {
  remoteHostId: string;
  baseRepo: string;
  sourceBranch: string | null;
  leaseId: string;
  generation: number;
}): Promise<RemoteBotWorktreeMeta> {
  const host = await readyHost(input.remoteHostId);
  const slug = `${input.leaseId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)}-${input.generation}`;
  const result = await host.exec(
    `bash -s -- ${shellBase64(input.baseRepo)} ${shellBase64(input.sourceBranch || 'HEAD')} ${shellBase64(slug)}`,
    {
      input: CREATE_SCRIPT,
      label: 'create remote Bot worktree',
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (result.exitCode !== 0 || result.truncated) {
    throw new Error(result.stderr.trim() || 'Remote Bot worktree creation failed');
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  return {
    path: decodeLine(lines[0], 'worktree path'),
    baseRepo: decodeLine(lines[1], 'repository path'),
    branch: decodeLine(lines[2], 'branch'),
    sourceBranch: decodeLine(lines[3], 'source branch'),
  };
}

export async function inspectRemoteBotWorktree(input: {
  remoteHostId: string;
  worktreePath: string;
  baseRepo: string;
  branch?: string | null;
}): Promise<{ exists: boolean; branch?: string }> {
  const host = await readyHost(input.remoteHostId);
  const result = await host.exec(
    `bash -s -- ${shellBase64(input.worktreePath)} ${shellBase64(input.baseRepo)} ${shellBase64(input.branch || '')}`,
    {
      input: INSPECT_SCRIPT,
      label: 'inspect remote Bot worktree',
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
    },
  );
  // Only a genuinely absent path is safe to treat as gone. A replaced path,
  // foreign repository, or changed branch must keep the lease recoverable.
  if (result.exitCode === 44) return { exists: false };
  if (result.exitCode !== 0 || result.truncated) {
    throw new Error(result.stderr.trim() || 'Remote Bot worktree inspection failed');
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  decodeLine(lines[0], 'worktree path');
  const branch = decodeLine(lines[1], 'branch');
  return { exists: true, ...(branch ? { branch } : {}) };
}

export async function removeRemoteBotWorktree(input: {
  remoteHostId: string;
  baseRepo: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  const host = await readyHost(input.remoteHostId);
  const result = await host.exec(
    `bash -s -- ${shellBase64(input.baseRepo)} ${shellBase64(input.worktreePath)} ${shellBase64(input.branch)}`,
    {
      input: REMOVE_SCRIPT,
      label: 'remove remote Bot worktree',
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (result.exitCode !== 0 || result.truncated) {
    throw new Error(
      result.stderr.trim()
      || 'Remote Bot worktree was retained because it is dirty, locked, or still in use',
    );
  }
}
