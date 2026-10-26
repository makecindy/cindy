/**
 * Claude accounts IPC: the renderer ↔ main boundary for the Settings accounts list and the
 * handoff dialog. Every handler checks the sender first and validates its payload at runtime.
 * Results are projected to renderer-safe views (no paths, no raw errors, no secrets).
 */
import type { IpcMainInvokeEvent } from 'electron';

import {
  CLAUDE_ACCOUNT_ID_PATTERN,
  CLAUDE_ACCOUNT_LOGIN_KEY_PATTERN,
  type ClaudeAccountAddResult,
  type ClaudeAccountHealthView,
  type ClaudeAccountSwitchResult,
  type ClaudeAccountView,
  type ClaudeAccountsListView,
  type ClaudeHandoffPreview,
} from '../../shared/claudeAccounts.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { planHandoff, type MissionSnapshot } from './handoff.js';
import { ClaudeAccountRegistryError } from './registry.js';
import type { ClaudeAccountsService } from './service.js';
import type { ClaudeAccount } from './types.js';

/** Raw label bound before the service trims and applies the real 40-character rule. */
const MAX_RAW_LABEL = 100;
const MAX_SESSION_ID = 200;
const HEALTHY_STATES = new Set(['linked', 'absent', 'copy']);

export interface ClaudeAccountsIpcDeps {
  service: () => ClaudeAccountsService;
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** A data owner is active and no owner switch is in progress. */
  ownerReady: () => boolean;
  /** Transcript path for a Cindy session; null if none; 'not_claude' for other harnesses. */
  findTranscript: (sessionId: string) => Promise<string | null | 'not_claude'>;
  readSnapshot: (file: string) => Promise<MissionSnapshot>;
}

function requireAccountId(value: unknown): string {
  if (typeof value !== 'string' || !CLAUDE_ACCOUNT_ID_PATTERN.test(value)) {
    throwIpcError('INVALID_PARAMS', 'accountId is invalid');
  }
  return value;
}

function requireLoginKey(value: unknown): string {
  if (typeof value !== 'string' || !CLAUDE_ACCOUNT_LOGIN_KEY_PATTERN.test(value)) {
    throwIpcError('INVALID_PARAMS', 'loginKey is invalid');
  }
  return value;
}

function accountView(account: ClaudeAccount, activeAccountId: string): ClaudeAccountView {
  return {
    id: account.id,
    kind: account.kind,
    label: account.label,
    ...(account.identity?.email ? { email: account.identity.email } : {}),
    ...(account.identity?.subscriptionType ? { subscriptionType: account.identity.subscriptionType } : {}),
    ...(account.lastUsedAt !== undefined ? { lastUsedAt: account.lastUsedAt } : {}),
    active: account.id === activeAccountId,
  };
}

export function createClaudeAccountsIpcHandlers(deps: ClaudeAccountsIpcDeps) {
  const logins = new Map<string, AbortController>();

  async function list(event: IpcMainInvokeEvent): Promise<ClaudeAccountsListView> {
    deps.assertTrusted(event);
    const state = await deps.service().listAccounts();
    return {
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map((a) => accountView(a, state.activeAccountId)),
    };
  }

  async function add(event: IpcMainInvokeEvent, payload: unknown): Promise<ClaudeAccountAddResult> {
    deps.assertTrusted(event);
    const body = requireObject(payload);
    const label = requireString(body.label, 'label');
    if (label.length > MAX_RAW_LABEL) throwIpcError('INVALID_PARAMS', 'label is too long');
    const loginKey = requireLoginKey(body.loginKey);
    if (!deps.ownerReady()) return { ok: false, reason: 'no_owner' };
    logins.get(loginKey)?.abort();
    const abort = new AbortController();
    logins.set(loginKey, abort);
    try {
      const result = await deps.service().addAccount({ label }, abort.signal);
      if (!result.ok) return { ok: false, reason: result.reason };
      const { activeAccountId } = await deps.service().listAccounts();
      return { ok: true, account: accountView(result.account, activeAccountId) };
    } finally {
      if (logins.get(loginKey) === abort) logins.delete(loginKey);
    }
  }

  async function cancelAdd(event: IpcMainInvokeEvent, loginKey: unknown): Promise<void> {
    deps.assertTrusted(event);
    const key = requireLoginKey(loginKey);
    logins.get(key)?.abort();
  }

  async function switchAccount(event: IpcMainInvokeEvent, accountId: unknown): Promise<ClaudeAccountSwitchResult> {
    deps.assertTrusted(event);
    const id = requireAccountId(accountId);
    if (!deps.ownerReady()) return { ok: false, reason: 'no_owner' };
    return deps.service().switchAccount(id);
  }

  async function remove(event: IpcMainInvokeEvent, accountId: unknown): Promise<{ ok: true }> {
    deps.assertTrusted(event);
    const id = requireAccountId(accountId);
    try {
      await deps.service().removeAccount(id);
    } catch (err) {
      if (err instanceof ClaudeAccountRegistryError) {
        throwIpcError(err.code === 'unknown_account' ? 'NOT_FOUND' : 'INVALID_PARAMS', err.message);
      }
      throwIpcError('INTERNAL', 'Could not remove the Claude account');
    }
    return { ok: true };
  }

  async function health(event: IpcMainInvokeEvent): Promise<ClaudeAccountHealthView[]> {
    deps.assertTrusted(event);
    const report = await deps.service().checkHealth();
    return report.map((h) => ({
      accountId: h.accountId,
      label: h.label,
      loggedIn: h.login.loggedIn,
      ...(h.login.email ? { email: h.login.email } : {}),
      ...(h.login.error ? { checkFailed: true as const } : {}),
      ...(h.profile
        ? {
            profile: {
              healthy: h.profile.healthy,
              mode: h.profile.mode,
              problems: h.profile.entries
                .filter((e) => !HEALTHY_STATES.has(e.state))
                .map((e) => ({ name: e.name, state: e.state })),
            },
          }
        : {}),
    }));
  }

  async function handoffPreview(event: IpcMainInvokeEvent, sessionId: unknown): Promise<ClaudeHandoffPreview> {
    deps.assertTrusted(event);
    const id = requireString(sessionId, 'sessionId');
    if (id.length > MAX_SESSION_ID) throwIpcError('INVALID_PARAMS', 'sessionId is too long');
    const file = await deps.findTranscript(id);
    if (file === null) return { available: false, reason: 'not_found' };
    if (file === 'not_claude') return { available: false, reason: 'not_claude' };
    let snapshot: MissionSnapshot;
    try {
      snapshot = await deps.readSnapshot(file);
    } catch {
      return { available: false, reason: 'unreadable' };
    }
    const plan = planHandoff(snapshot);
    return {
      available: true,
      recommended: plan.recommended,
      resumeTokens: plan.resume.estimatedTokens,
      briefTokens: plan.brief.estimatedTokens,
      brief: plan.brief.text,
      ...(snapshot.goal ? { goal: snapshot.goal } : {}),
      userTurns: snapshot.userTurns,
      filesTouched: snapshot.filesTouched.length,
      ...(snapshot.interrupted ? { interruptedTool: snapshot.interrupted.tool } : {}),
    };
  }

  return { list, add, cancelAdd, switchAccount, remove, health, handoffPreview };
}
