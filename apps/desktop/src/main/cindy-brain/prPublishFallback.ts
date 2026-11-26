/**
 * prPublishFallback.ts — Turn-end fallback for missed `cindy-github` `pr_card(published: true)`.
 *
 * When a long desktop user turn runs `gh pr create` via a shell tool and succeeds
 * (emitting a new GitHub PR URL), but the model finishes the turn without calling
 * `cindy-github`'s `pr_card`, saved post-publication preferences (`auto_follow`)
 * would silently never run.
 *
 * This module observes tool events within a user turn and, on normal completion,
 * invokes `cindy-github` / `pr_card({ repo, pr, published: true })` ONLY for PRs
 * confirmed created by `gh pr create` in that same turn and not already handled by
 * `pr_card`. Ordinary PR links in chat or `gh pr view` / `gh pr list` never trigger it.
 *
 * Pure tracker + dependency-injected orchestrator; desktop wiring lives in
 * `cindy-brain/index.ts`.
 */

import { randomUUID } from 'node:crypto';
import { extractPrRefs, type PrRef } from '../git-context/prRefExtractor.js';
import type { MinimalAgentEvent } from './subscriptionGateway.js';

export const CINDY_GITHUB_GHOST_ID = 'cindy-github';
export const CINDY_GITHUB_PR_CARD_TOOL = 'pr_card';

const SHELL_TOOL_NAMES = new Set(['bash', 'exec', 'exec_command', 'shell', 'run_command', 'terminal']);
const SHELL_WRAPPER_RE = /^\s*(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(['"])([\s\S]*)\1\s*$/;
const SEGMENT_SPLIT_RE = /(?:&&|\|\||[;\n|])+/;
const GH_PR_CREATE_RE = /^\s*(?:(?:\(|\$\(\s*)*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`]+)\s+)*(?:env\s+)?(?:(?:\/[^\s"']+\/)?gh)\s+pr\s+create(?:\s|$)/;
const GH_NON_PUBLISH_FLAG_RE = /(?:^|\s)(?:--help|-h|--dry-run)(?:\s|$)/;

function prKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`;
}

function unwrapShellCommand(raw: string): string {
  const m = SHELL_WRAPPER_RE.exec(raw);
  if (!m) return raw;
  const quote = m[1];
  const inner = m[2];
  return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
}

/**
 * Determine whether a shell command invokes `gh pr create` (excluding `--help` / `--dry-run`
 * and literal strings inside `echo` / `grep` / `rg`).
 */
export function isGhPrCreateCommand(command: string): boolean {
  if (!command || !command.includes('gh')) return false;
  const candidates = [command];
  const unwrapped = unwrapShellCommand(command);
  if (unwrapped !== command) candidates.push(unwrapped);

  for (const text of candidates) {
    for (const segment of text.split(SEGMENT_SPLIT_RE)) {
      if (!segment.includes('gh')) continue;
      // Strip simple variable assignment like `PR_URL=$(gh pr create ...)`
      const normalized = segment.replace(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\$\(\s*/, '');
      if (GH_PR_CREATE_RE.test(normalized) && !GH_NON_PUBLISH_FLAG_RE.test(normalized)) {
        return true;
      }
    }
  }
  return false;
}

function extractShellCommand(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command;
  if (typeof rec.cmd === 'string') return rec.cmd;
  return null;
}

function isShellToolName(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (SHELL_TOOL_NAMES.has(lower)) return true;
  const tail = lower.split(/[:.]/).pop() ?? '';
  return SHELL_TOOL_NAMES.has(tail);
}

interface PendingPrCardCall {
  repo: string | null;
  pr: string | null;
  published: boolean;
  afterCreateCount: number;
}

function parsePrCardCall(toolName: string, input: unknown): PendingPrCardCall | null {
  const lower = toolName.trim().toLowerCase();
  if (!lower.endsWith('ghost_call')) return null;
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  if (rec.ghost_id !== CINDY_GITHUB_GHOST_ID || rec.tool !== CINDY_GITHUB_PR_CARD_TOOL) return null;
  const args = rec.args && typeof rec.args === 'object' ? (rec.args as Record<string, unknown>) : {};
  return {
    repo: typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : null,
    pr: typeof args.pr === 'string' || typeof args.pr === 'number' ? String(args.pr).trim() : null,
    published: args.published === true,
    afterCreateCount: 0,
  };
}

function extractToolResultInfo(event: MinimalAgentEvent): { ids: string[]; text: string; isError: boolean } | null {
  if (!event.data || typeof event.data !== 'object') return null;
  const data = event.data as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof data.toolUseId === 'string' && data.toolUseId) ids.push(data.toolUseId);
  if (Array.isArray(data.toolUseIds)) {
    for (const id of data.toolUseIds) {
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length === 0) return null;

  let text = '';
  if (typeof data.fullText === 'string') text = data.fullText;
  else if (typeof data.summary === 'string') text = data.summary;
  else if (typeof data.content === 'string') text = data.content;
  else if (data.content !== undefined) {
    try { text = JSON.stringify(data.content); } catch { text = ''; }
  }

  const isError = data.isError === true || text.trimStart().startsWith('<tool_use_error>');
  return { ids, text, isError };
}

function isGhostToolErrorPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown };
    return parsed.ok === false;
  } catch {
    return false;
  }
}

function parseRepoPrKey(repo: string | null, pr: string | null): string | null {
  if (pr) {
    const fromUrl = extractPrRefs(pr).find((ref) => !ref.provider || ref.provider === 'github');
    if (fromUrl) return prKey(fromUrl.owner, fromUrl.repo, fromUrl.prNumber);
  }
  if (repo && pr && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && /^\d+$/.test(pr)) {
    const [owner, name] = repo.split('/');
    const num = Number(pr);
    if (owner && name && Number.isSafeInteger(num) && num > 0) return prKey(owner, name, num);
  }
  return null;
}

/**
 * Per-session, per-turn tracker that records GitHub PRs created via `gh pr create`
 * and suppresses fallback whenever `cindy-github` `pr_card` already handled them.
 */
export class TurnPrPublishTracker {
  private readonly pendingCreateIds = new Set<string>();
  private readonly pendingPrCardCalls = new Map<string, PendingPrCardCall>();
  private readonly createdPrs = new Map<string, PrRef>();
  private readonly handledPrKeys = new Set<string>();
  private prCardSucceededAfterCreate = false;

  beginTurn(): void {
    this.pendingCreateIds.clear();
    this.pendingPrCardCalls.clear();
    this.createdPrs.clear();
    this.handledPrKeys.clear();
    this.prCardSucceededAfterCreate = false;
  }

  handleEvent(event: MinimalAgentEvent): void {
    if (event.type === 'tool_use') {
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as { toolUseId?: unknown; toolName?: unknown; input?: unknown };
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : '';
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      if (!toolUseId || !toolName) return;

      if (isShellToolName(toolName)) {
        const command = extractShellCommand(data.input);
        if (command && isGhPrCreateCommand(command)) {
          this.pendingCreateIds.add(toolUseId);
        }
        return;
      }

      const prCardCall = parsePrCardCall(toolName, data.input);
      if (prCardCall) {
        prCardCall.afterCreateCount = this.createdPrs.size;
        this.pendingPrCardCalls.set(toolUseId, prCardCall);
      }
      return;
    }

    if (event.type !== 'tool_result' && event.type !== 'tool_result_full') return;
    const info = extractToolResultInfo(event);
    if (!info) return;

    for (const id of info.ids) {
      if (this.pendingCreateIds.has(id)) {
        if (!info.isError) {
          const githubRefs = extractPrRefs(info.text).filter(
            (ref) => !ref.provider || ref.provider === 'github',
          );
          if (githubRefs.length === 1) {
            const ref = githubRefs[0];
            this.createdPrs.set(prKey(ref.owner, ref.repo, ref.prNumber), ref);
          }
        }
      }

      const prCardCall = this.pendingPrCardCalls.get(id);
      if (prCardCall) {
        if (!info.isError && !isGhostToolErrorPayload(info.text)) {
          const argKey = parseRepoPrKey(prCardCall.repo, prCardCall.pr);
          if (argKey) this.handledPrKeys.add(argKey);
          for (const ref of extractPrRefs(info.text)) {
            if (!ref.provider || ref.provider === 'github') {
              this.handledPrKeys.add(prKey(ref.owner, ref.repo, ref.prNumber));
            }
          }
          if (prCardCall.afterCreateCount > 0 || prCardCall.published) {
            this.prCardSucceededAfterCreate = true;
          }
        }
      }
    }
  }

  /** Complete the current turn, reset state, and return PRs that still need a `pr_card(published: true)` handoff. */
  finishTurn(completed: boolean): PrRef[] {
    const unhandled =
      completed && !this.prCardSucceededAfterCreate
        ? [...this.createdPrs.values()].filter(
            (pr) => !this.handledPrKeys.has(prKey(pr.owner, pr.repo, pr.prNumber)),
          )
        : [];
    this.beginTurn();
    return unhandled;
  }
}

export interface PrPublishFallbackTarget {
  instanceId: string;
  logicalGhostId: string;
  wantsSessionContext: boolean;
}

export interface PrPublishFallbackSessionSnapshot {
  workingDir: string | null;
  remoteHostId: string | null;
  workdirIsReadOnly: boolean;
}

export interface PrPublishFallbackDeps {
  isCurrent(): boolean;
  getSessionSnapshot(sessionId: string): Promise<PrPublishFallbackSessionSnapshot | null>;
  resolveGithubTarget(workingDir: string | null): Promise<PrPublishFallbackTarget | null>;
  buildSessionContext(
    sessionId: string,
    snapshot: PrPublishFallbackSessionSnapshot,
  ): Record<string, unknown>;
  registerCardCall(
    callId: string,
    target: PrPublishFallbackTarget,
    sessionId: string,
  ): void;
  finalizeCardCall(callId: string): void;
  callPrCard(request: {
    instanceId: string;
    callId: string;
    sessionId: string;
    args: Record<string, unknown>;
  }): Promise<{ ok: boolean; result?: unknown; errorCode?: string }>;
  createCallId?: () => string;
  log?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Invoke `cindy-github` `pr_card(published: true)` for PRs newly created via `gh pr create`
 * when the turn ended without calling `pr_card`. Always fail-open and owner-fenced.
 */
export async function runPublishedPrCardFallback(
  deps: PrPublishFallbackDeps,
  sessionId: string,
  prs: readonly PrRef[],
): Promise<void> {
  if (prs.length === 0) return;
  try {
    if (!deps.isCurrent()) return;
    const snapshot = await deps.getSessionSnapshot(sessionId);
    if (!deps.isCurrent()) return;
    // Local desktop tasks only; remote SSH sessions do not bind local cindy-github schedules.
    if (!snapshot || snapshot.remoteHostId !== null) return;

    const target = await deps.resolveGithubTarget(snapshot.workingDir);
    if (!target || !deps.isCurrent()) return;

    const sessionContext = target.wantsSessionContext
      ? deps.buildSessionContext(sessionId, snapshot)
      : null;

    for (const pr of prs) {
      if (!deps.isCurrent()) return;
      const callId = deps.createCallId ? deps.createCallId() : randomUUID();
      const repo = `${pr.owner}/${pr.repo}`;
      const args: Record<string, unknown> = {
        repo,
        pr: String(pr.prNumber),
        published: true,
        ...(sessionContext ? { session_context: sessionContext } : {}),
      };
      deps.registerCardCall(callId, target, sessionId);
      try {
        const res = await deps.callPrCard({
          instanceId: target.instanceId,
          callId,
          sessionId,
          args,
        });
        const followState =
          res.ok && res.result && typeof res.result === 'object'
            ? (res.result as { follow_state?: unknown }).follow_state
            : undefined;
        deps.log?.info('pr publish turn-end fallback invoked cindy-github pr_card', {
          sessionId,
          repo,
          prNumber: pr.prNumber,
          ok: res.ok,
          ...(typeof followState === 'string' ? { followState } : {}),
          ...(res.errorCode ? { errorCode: res.errorCode } : {}),
        });
      } finally {
        deps.finalizeCardCall(callId);
      }
    }
  } catch (err) {
    deps.log?.warn('pr publish turn-end fallback failed (fail-open)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
