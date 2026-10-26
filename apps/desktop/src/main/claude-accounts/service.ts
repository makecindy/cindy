/**
 * Claude accounts service: the only writer of the account registry.
 *
 * - add: create a linked profile, run the official CLI login inside it once, keep the account
 *   only if that login produced a new Claude subscription (otherwise roll back the profile);
 * - switch: no login, just verify the target is still logged in and persist the choice;
 *   `onActiveAccountChanged` lets the host rebuild live sessions at their next turn boundary;
 * - remove: drop the profile (links first, master data untouched) and fall back to master.
 *
 * Electron-free: paths, CLI and the change hook are injected. Mutations are serialised.
 * Design: docs/dev-rules/claude-multi-account.md §4.
 */
import path from 'node:path';

import type { ClaudeCliLoginResult } from '../maker-host/claude-native-cli.js';
import type { ClaudeCliLoginStatus } from '../maker-host/claude-native-cli-status.js';
import { profileDirFor, resolveClaudeAccountEnv } from './accountEnv.js';
import { inspectProfile, prepareProfile, removeProfile, type ProfileHealth } from './profileLinker.js';
import {
  ClaudeAccountRegistryError,
  addAccount as addToRegistry,
  createRegistryStore,
  defaultRegistryDeps,
  removeAccount as removeFromRegistry,
  setActiveAccount,
  touchAccount,
  updateIdentity,
} from './registry.js';
import { MASTER_ACCOUNT_ID, type ClaudeAccount, type ClaudeAccountRegistryState } from './types.js';

export interface ClaudeAccountsCli {
  probe(accountEnv: Record<string, string>): Promise<ClaudeCliLoginStatus>;
  login(accountEnv: Record<string, string>, signal: AbortSignal): Promise<ClaudeCliLoginResult>;
}

type LoginFailure = Extract<ClaudeCliLoginResult, { ok: false }>['reason'];

export type AddAccountResult =
  | { ok: true; account: ClaudeAccount }
  | { ok: false; reason: LoginFailure | 'duplicate_identity' | 'invalid_label' | 'profile_unavailable' };

export type SwitchAccountResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_account' | 'not_logged_in' | 'profile_unavailable' };

export interface AccountHealth {
  accountId: string;
  label: string;
  login: ClaudeCliLoginStatus & { error?: string };
  /** Extra accounts only. */
  profile?: ProfileHealth;
}

export interface ClaudeAccountsServiceDeps {
  accountsRoot: string;
  masterDir: string;
  registryFile: string;
  cli: ClaudeAccountsCli;
  onActiveAccountChanged?: (change: { previousId: string; nextId: string }) => Promise<void> | void;
  now?: () => number;
  newId?: () => string;
  log?: { info?: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void };
}

export function createClaudeAccountsService(deps: ClaudeAccountsServiceDeps) {
  const now = deps.now ?? defaultRegistryDeps.now;
  const registryDeps = { now, newId: deps.newId ?? defaultRegistryDeps.newId };
  const store = createRegistryStore({ filePath: deps.registryFile, now, ...(deps.log ? { log: deps.log } : {}) });
  const linkPaths = (profileDir: string) => ({ profileDir, masterDir: deps.masterDir, accountsRoot: deps.accountsRoot });

  let loaded: Promise<ClaudeAccountRegistryState> | null = null;
  let current: ClaudeAccountRegistryState | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  async function state(): Promise<ClaudeAccountRegistryState> {
    if (current) return current;
    loaded ??= store.load().then((s) => (current = s));
    return loaded;
  }

  async function commit(next: ClaudeAccountRegistryState): Promise<void> {
    await store.save(next);
    current = next;
  }

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function notify(previousId: string, nextId: string): Promise<void> {
    if (previousId === nextId || !deps.onActiveAccountChanged) return;
    try {
      await deps.onActiveAccountChanged({ previousId, nextId });
    } catch (err) {
      deps.log?.warn('claude account change hook failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function discardProfile(profileDir: string): Promise<void> {
    try {
      await removeProfile(linkPaths(profileDir));
    } catch (err) {
      deps.log?.warn('claude account profile rollback failed', {
        profileDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function listAccounts(): Promise<ClaudeAccountRegistryState> {
    return state();
  }

  async function activeAccountEnv(): Promise<Record<string, string>> {
    const s = await state();
    const account = s.accounts.find((a) => a.id === s.activeAccountId) ?? s.accounts[0]!;
    const resolved = await resolveClaudeAccountEnv({
      account,
      accountsRoot: deps.accountsRoot,
      masterDir: deps.masterDir,
      prepare: prepareProfile,
    });
    if (resolved.report && (resolved.report.conflicts.length > 0 || resolved.report.mode === 'mirror')) {
      deps.log?.warn('claude account profile reconciled', {
        accountId: account.id,
        mode: resolved.report.mode,
        conflicts: resolved.report.conflicts,
      });
    }
    return resolved.env;
  }

  function addAccount(input: { label: string }, signal: AbortSignal): Promise<AddAccountResult> {
    return serial(async () => {
      let s = await state();
      let account: ClaudeAccount;
      try {
        ({ state: s, account } = addToRegistry(s, { label: input.label }, registryDeps));
      } catch (err) {
        if (err instanceof ClaudeAccountRegistryError && err.code === 'invalid_label') return { ok: false, reason: 'invalid_label' };
        throw err;
      }
      // Learn the master's identity so the same Claude account cannot be added twice.
      const master = s.accounts.find((a) => a.id === MASTER_ACCOUNT_ID);
      if (!master?.identity?.email) {
        try {
          const status = await deps.cli.probe({});
          if (status.loggedIn && status.email) {
            s = updateIdentity(s, MASTER_ACCOUNT_ID, { email: status.email, ...(status.subscriptionType ? { subscriptionType: status.subscriptionType } : {}) });
          }
        } catch {
          /* master identity is best effort; duplicates of extra accounts are still caught */
        }
      }
      const profileDir = profileDirFor(deps.accountsRoot, account.id);
      try {
        await prepareProfile(linkPaths(profileDir));
      } catch (err) {
        deps.log?.warn('claude account profile could not be prepared', {
          error: err instanceof Error ? err.message : String(err),
        });
        await discardProfile(profileDir);
        return { ok: false, reason: 'profile_unavailable' };
      }
      const login = await deps.cli.login({ CLAUDE_CONFIG_DIR: profileDir }, signal);
      if (!login.ok) {
        await discardProfile(profileDir);
        return { ok: false, reason: login.reason };
      }
      try {
        s = updateIdentity(s, account.id, {
          ...(login.status.email ? { email: login.status.email } : {}),
          ...(login.status.subscriptionType ? { subscriptionType: login.status.subscriptionType } : {}),
        });
      } catch (err) {
        if (err instanceof ClaudeAccountRegistryError && err.code === 'duplicate_identity') {
          await discardProfile(profileDir);
          return { ok: false, reason: 'duplicate_identity' };
        }
        throw err;
      }
      await commit(s);
      deps.log?.info?.('claude account added', { accountId: account.id });
      return { ok: true, account: s.accounts.find((a) => a.id === account.id)! };
    });
  }

  function switchAccount(id: string): Promise<SwitchAccountResult> {
    return serial(async () => {
      const s = await state();
      const target = s.accounts.find((a) => a.id === id);
      if (!target) return { ok: false, reason: 'unknown_account' };
      if (s.activeAccountId === id) return { ok: true };
      if (target.kind === 'extra') {
        let env: Record<string, string>;
        try {
          env = (
            await resolveClaudeAccountEnv({
              account: target,
              accountsRoot: deps.accountsRoot,
              masterDir: deps.masterDir,
              prepare: prepareProfile,
            })
          ).env;
        } catch {
          return { ok: false, reason: 'profile_unavailable' };
        }
        const status = await deps.cli.probe(env).catch(() => ({ loggedIn: false }) as ClaudeCliLoginStatus);
        if (!status.loggedIn) return { ok: false, reason: 'not_logged_in' };
      }
      const previousId = s.activeAccountId;
      await commit(touchAccount(setActiveAccount(s, id), id, now()));
      deps.log?.info?.('claude account switched', { previousId, nextId: id });
      await notify(previousId, id);
      return { ok: true };
    });
  }

  function removeAccount(id: string): Promise<void> {
    return serial(async () => {
      const s = await state();
      const next = removeFromRegistry(s, id);
      await removeProfile(linkPaths(profileDirFor(deps.accountsRoot, id)));
      await commit(next);
      deps.log?.info?.('claude account removed', { accountId: id });
      await notify(s.activeAccountId, next.activeAccountId);
    });
  }

  async function checkHealth(): Promise<AccountHealth[]> {
    const s = await state();
    const out: AccountHealth[] = [];
    for (const account of s.accounts) {
      const profileDir = account.kind === 'extra' ? path.join(deps.accountsRoot, account.id) : null;
      let login: AccountHealth['login'];
      try {
        login = await deps.cli.probe(profileDir ? { CLAUDE_CONFIG_DIR: profileDir } : {});
      } catch (err) {
        login = { loggedIn: false, error: err instanceof Error ? err.message : String(err) };
      }
      out.push({
        accountId: account.id,
        label: account.label,
        login,
        ...(profileDir ? { profile: await inspectProfile(linkPaths(profileDir)) } : {}),
      });
    }
    return out;
  }

  return { listAccounts, activeAccountEnv, addAccount, switchAccount, removeAccount, checkHealth };
}

export type ClaudeAccountsService = ReturnType<typeof createClaudeAccountsService>;
