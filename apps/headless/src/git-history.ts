import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { HeadlessSessionMeta } from './session-types.js';

const exec = promisify(execFile);

type SavepointKind = 'before-edit' | 'after-edit';
type Savepoint = { commit: string; sessionId: string; anchorClientId: string; kind: SavepointKind; repoRoot: string; branch: string; createdAt: number };

/**
 * Small Linux adaptation of Desktop's Codex Git-savepoint design.  It only
 * operates on a clean index, creates local-only snapshot commits, and refuses
 * to touch a repository during merge/rebase/conflict states.  That fail-closed
 * boundary is essential: conversation rewind remains possible, but files are
 * never guessed or partially overwritten.
 */
export class HeadlessGitHistory {
  private readonly db: Database.Database;
  private readonly activeAnchors = new Map<string, { session: HeadlessSessionMeta; clientId: string }>();

  constructor(databaseFile: string) {
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS headless_git_savepoints (
      commit_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, anchor_client_id TEXT NOT NULL,
      kind TEXT NOT NULL, repo_root TEXT NOT NULL, branch TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS headless_git_savepoints_session ON headless_git_savepoints(session_id, created_at DESC);`);
  }

  async beginTurn(session: HeadlessSessionMeta, clientId: string): Promise<void> {
    if (session.agentKind !== 'codex') return;
    this.activeAnchors.set(session.id, { session, clientId });
    await this.snapshot(session, clientId, 'before-edit').catch(() => undefined);
  }

  async finishTurn(sessionId: string): Promise<void> {
    const active = this.activeAnchors.get(sessionId);
    if (!active) return;
    this.activeAnchors.delete(sessionId);
    await this.snapshot(active.session, active.clientId, 'after-edit').catch(() => undefined);
  }

  async preview(session: HeadlessSessionMeta, targetClientId: string, userClientIds: string[]): Promise<{ canRewind: boolean; filesChanged: string[]; insertions: number; deletions: number }> {
    const selected = await this.selected(session, targetClientId, userClientIds);
    if (selected.length === 0) return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
    const files = new Set<string>(); let insertions = 0; let deletions = 0;
    for (const point of selected) {
      const { stdout } = await git(['show', '--format=', '--numstat', point.commit], point.repoRoot);
      for (const line of stdout.split('\n')) {
        const [added, deleted, file] = line.split('\t');
        if (!file) continue;
        files.add(file); insertions += number(deleted); deletions += number(added);
      }
    }
    return { canRewind: true, filesChanged: [...files], insertions, deletions };
  }

  /** Applies all after-edit savepoints at/after the target as one protected local rollback commit. */
  async commit(session: HeadlessSessionMeta, targetClientId: string, userClientIds: string[]): Promise<{ rollbackCommit: string | null }> {
    const selected = await this.selected(session, targetClientId, userClientIds);
    if (selected.length === 0) return { rollbackCommit: null };
    const repoRoot = selected[0]!.repoRoot;
    await assertSafeRepo(repoRoot);
    const head = (await git(['rev-parse', 'HEAD'], repoRoot)).stdout.trim();
    const protectRef = `refs/cindy-headless/pre-rewind/${randomUUID()}`;
    await git(['update-ref', protectRef, head], repoRoot);
    try {
      for (const point of selected) await git(['revert', '--no-commit', point.commit], repoRoot);
      const staged = await changedCached(repoRoot);
      if (!staged) { await git(['revert', '--quit'], repoRoot).catch(() => undefined); return { rollbackCommit: null }; }
      await git(['-c', 'user.name=Cindy Headless', '-c', 'user.email=cindy-headless@localhost', 'commit', '--no-verify', '--no-gpg-sign', '-m', `Cindy rewind files\n\nCindy-Session: ${session.id}\nCindy-Rewind-Target: ${targetClientId}`], repoRoot);
      return { rollbackCommit: (await git(['rev-parse', 'HEAD'], repoRoot)).stdout.trim() };
    } catch (error) {
      await git(['revert', '--abort'], repoRoot).catch(() => undefined);
      await git(['reset', '--hard', protectRef], repoRoot).catch(() => undefined);
      throw new Error(`Codex file rewind aborted safely: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await git(['update-ref', '-d', protectRef], repoRoot).catch(() => undefined);
    }
  }

  async compensate(session: HeadlessSessionMeta, rollbackCommit: string | null): Promise<void> {
    if (!rollbackCommit) return;
    const repoRoot = await repoFor(session);
    if (!repoRoot) return;
    await assertNoGitOperation(repoRoot);
    await git(['revert', '--no-edit', rollbackCommit], repoRoot);
  }

  close(): void { this.db.close(); }

  private async snapshot(session: HeadlessSessionMeta, anchorClientId: string, kind: SavepointKind): Promise<void> {
    const repoRoot = await repoFor(session);
    if (!repoRoot) return;
    await assertNoGitOperation(repoRoot);
    // Preserve an explicit user index.  Snapshotting a partially staged tree
    // would silently alter the user's commit intent, so wait for a clean index.
    if (await changedCached(repoRoot)) return;
    const dirty = (await git(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)).stdout;
    if (!dirty.trim()) return;
    // Keep secrets out of automatic history.  Desktop has a richer safety
    // filter; this host uses a conservative fail-closed subset for server use.
    const unsafe = dirty.split('\n').some((line) => /(^|\/)(\.env|.*\.(pem|key|p12|pfx))$/i.test(line.slice(3).trim()));
    if (unsafe) return;
    await git(['add', '-A'], repoRoot);
    const branch = (await git(['branch', '--show-current'], repoRoot)).stdout.trim() || 'HEAD';
    await git(['-c', 'user.name=Cindy Headless', '-c', 'user.email=cindy-headless@localhost', 'commit', '--no-verify', '--no-gpg-sign', '-m', `Cindy ${kind}\n\nCindy-Session: ${session.id}\nCindy-Anchor: ${anchorClientId}\nCindy-Kind: ${kind}\nCindy-Branch: ${branch}`], repoRoot);
    const commit = (await git(['rev-parse', 'HEAD'], repoRoot)).stdout.trim();
    this.db.prepare(`INSERT OR REPLACE INTO headless_git_savepoints
      (commit_hash, session_id, anchor_client_id, kind, repo_root, branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(commit, session.id, anchorClientId, kind, repoRoot, branch, Date.now());
  }

  private async selected(session: HeadlessSessionMeta, targetClientId: string, userClientIds: string[]): Promise<Savepoint[]> {
    const targetIndex = userClientIds.indexOf(targetClientId);
    if (targetIndex < 0) throw new Error('Rewind target is not in the visible user timeline');
    const root = await repoFor(session);
    if (!root) return [];
    const branch = (await git(['branch', '--show-current'], root)).stdout.trim() || 'HEAD';
    const anchors = new Set(userClientIds.slice(targetIndex));
    const rows = this.db.prepare(`SELECT commit_hash, session_id, anchor_client_id, kind, repo_root, branch, created_at
      FROM headless_git_savepoints WHERE session_id = ? AND repo_root = ? AND branch = ? AND kind = 'after-edit'
      ORDER BY created_at DESC`).all(session.id, root, branch) as Array<{
        commit_hash: string; session_id: string; anchor_client_id: string; kind: SavepointKind; repo_root: string; branch: string; created_at: number;
      }>;
    const reachable: Savepoint[] = [];
    for (const row of rows) {
      if (!anchors.has(row.anchor_client_id)) continue;
      const present = await git(['merge-base', '--is-ancestor', row.commit_hash, 'HEAD'], root).then(() => true, () => false);
      if (!present) continue;
      reachable.push({ commit: row.commit_hash, sessionId: row.session_id, anchorClientId: row.anchor_client_id, kind: row.kind, repoRoot: row.repo_root, branch: row.branch, createdAt: row.created_at });
    }
    return reachable;
  }
}

async function repoFor(session: HeadlessSessionMeta): Promise<string | null> {
  if (!session.workDir) return null;
  try { return (await git(['rev-parse', '--show-toplevel'], session.workDir)).stdout.trim() || null; } catch { return null; }
}

async function assertNoGitOperation(root: string): Promise<void> {
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  for (const marker of markers) {
    const path = (await git(['rev-parse', '--git-path', marker], root)).stdout.trim();
    if (path) {
      const exists = await exec('test', ['-e', path], { cwd: root }).then(() => true, () => false);
      if (exists) throw new Error('Git operation is in progress');
    }
  }
}

async function assertSafeRepo(root: string): Promise<void> {
  await assertNoGitOperation(root);
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'], root)).stdout;
  if (status.trim()) throw new Error('Git worktree must be clean for a safe file rewind');
}

async function changedCached(root: string): Promise<boolean> {
  return git(['diff', '--cached', '--quiet'], root).then(() => false, () => true);
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

function number(value: string | undefined): number { const n = Number.parseInt(value ?? '', 10); return Number.isFinite(n) ? n : 0; }
