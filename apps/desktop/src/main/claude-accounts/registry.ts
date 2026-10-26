/**
 * Claude account registry: which accounts exist and which one is active.
 *
 * State transitions are pure and never mutate their input. The store persists with an
 * atomic temp-file + rename and keeps an unreadable file aside instead of overwriting it.
 * The registry holds no secrets: credentials stay in each account's CLI config dir.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MASTER_ACCOUNT_ID,
  isExtraAccountId,
  type ClaudeAccount,
  type ClaudeAccountIdentity,
  type ClaudeAccountRegistryState,
} from './types.js';

export type ClaudeAccountRegistryErrorCode =
  | 'invalid_label'
  | 'invalid_id'
  | 'id_collision'
  | 'duplicate_identity'
  | 'unknown_account'
  | 'master_immutable';

export class ClaudeAccountRegistryError extends Error {
  constructor(readonly code: ClaudeAccountRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeAccountRegistryError';
  }
}

export interface RegistryDeps {
  now: () => number;
  newId: () => string;
}

const MAX_LABEL_LENGTH = 40;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function generateAccountId(): string {
  return `acct_${randomBytes(8).toString('hex')}`;
}

export const defaultRegistryDeps: RegistryDeps = { now: () => Date.now(), newId: generateAccountId };

function masterAccount(now: number): ClaudeAccount {
  return { id: MASTER_ACCOUNT_ID, kind: 'master', label: 'Master', createdAt: now };
}

export function emptyRegistry(now: number): ClaudeAccountRegistryState {
  return { version: 1, activeAccountId: MASTER_ACCOUNT_ID, accounts: [masterAccount(now)] };
}

function normalizeLabel(raw: string): string {
  const label = raw.trim();
  if (!label || label.length > MAX_LABEL_LENGTH || CONTROL_CHARS.test(label)) {
    throw new ClaudeAccountRegistryError('invalid_label', `label must be 1-${MAX_LABEL_LENGTH} printable characters`);
  }
  return label;
}

function emailKey(identity: ClaudeAccountIdentity | undefined): string | null {
  const email = identity?.email?.trim().toLowerCase();
  return email ? email : null;
}

function assertUniqueIdentity(
  state: ClaudeAccountRegistryState,
  identity: ClaudeAccountIdentity | undefined,
  selfId: string | null,
): void {
  const key = emailKey(identity);
  if (!key) return;
  const clash = state.accounts.find((a) => a.id !== selfId && emailKey(a.identity) === key);
  if (clash) {
    throw new ClaudeAccountRegistryError('duplicate_identity', `this Claude account is already added as "${clash.label}"`);
  }
}

function requireAccount(state: ClaudeAccountRegistryState, id: string): ClaudeAccount {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) throw new ClaudeAccountRegistryError('unknown_account', `unknown Claude account: ${id}`);
  return account;
}

function cleanIdentity(identity: ClaudeAccountIdentity | undefined): ClaudeAccountIdentity | undefined {
  if (!identity) return undefined;
  const email = identity.email?.trim();
  const subscriptionType = identity.subscriptionType?.trim();
  if (!email && !subscriptionType) return undefined;
  return { ...(email ? { email } : {}), ...(subscriptionType ? { subscriptionType } : {}) };
}

export function addAccount(
  state: ClaudeAccountRegistryState,
  input: { label: string; identity?: ClaudeAccountIdentity },
  deps: RegistryDeps = defaultRegistryDeps,
): { state: ClaudeAccountRegistryState; account: ClaudeAccount } {
  const label = normalizeLabel(input.label);
  const identity = cleanIdentity(input.identity);
  assertUniqueIdentity(state, identity, null);
  const id = deps.newId();
  if (!isExtraAccountId(id)) throw new ClaudeAccountRegistryError('invalid_id', 'generated account id is malformed');
  if (state.accounts.some((a) => a.id === id)) {
    throw new ClaudeAccountRegistryError('id_collision', 'generated account id already exists');
  }
  const account: ClaudeAccount = { id, kind: 'extra', label, createdAt: deps.now(), ...(identity ? { identity } : {}) };
  return { state: { ...state, accounts: [...state.accounts, account] }, account };
}

export function removeAccount(state: ClaudeAccountRegistryState, id: string): ClaudeAccountRegistryState {
  if (id === MASTER_ACCOUNT_ID) {
    throw new ClaudeAccountRegistryError('master_immutable', 'the master account cannot be removed');
  }
  requireAccount(state, id);
  return {
    ...state,
    activeAccountId: state.activeAccountId === id ? MASTER_ACCOUNT_ID : state.activeAccountId,
    accounts: state.accounts.filter((a) => a.id !== id),
  };
}

export function setActiveAccount(state: ClaudeAccountRegistryState, id: string): ClaudeAccountRegistryState {
  requireAccount(state, id);
  return { ...state, activeAccountId: id };
}

function replaceAccount(
  state: ClaudeAccountRegistryState,
  id: string,
  patch: (account: ClaudeAccount) => ClaudeAccount,
): ClaudeAccountRegistryState {
  requireAccount(state, id);
  return { ...state, accounts: state.accounts.map((a) => (a.id === id ? patch(a) : a)) };
}

export function touchAccount(state: ClaudeAccountRegistryState, id: string, now: number): ClaudeAccountRegistryState {
  return replaceAccount(state, id, (a) => ({ ...a, lastUsedAt: now }));
}

export function updateIdentity(
  state: ClaudeAccountRegistryState,
  id: string,
  identity: ClaudeAccountIdentity,
): ClaudeAccountRegistryState {
  const cleaned = cleanIdentity(identity);
  assertUniqueIdentity(state, cleaned, id);
  return replaceAccount(state, id, (a) => {
    const { identity: _old, ...rest } = a;
    return cleaned ? { ...rest, identity: cleaned } : rest;
  });
}

// ── parsing ───────────────────────────────────────────────────────────────────

export interface ParsedRegistry {
  state: ClaudeAccountRegistryState;
  /** corrupt / unsupported_version → unusable, replaced by master-only; repaired → entries were dropped. */
  problem?: 'corrupt' | 'unsupported_version' | 'repaired';
}

function parseAccount(raw: unknown): ClaudeAccount | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.label !== 'string' || typeof r.createdAt !== 'number') return null;
  const kind = r.id === MASTER_ACCOUNT_ID ? 'master' : isExtraAccountId(r.id) ? 'extra' : null;
  if (!kind || r.kind !== kind) return null;
  const label = r.label.trim();
  if (!label || label.length > MAX_LABEL_LENGTH || CONTROL_CHARS.test(label)) return null;
  const identityRaw = r.identity && typeof r.identity === 'object' ? (r.identity as Record<string, unknown>) : null;
  const identity = cleanIdentity(
    identityRaw
      ? {
          ...(typeof identityRaw.email === 'string' ? { email: identityRaw.email } : {}),
          ...(typeof identityRaw.subscriptionType === 'string' ? { subscriptionType: identityRaw.subscriptionType } : {}),
        }
      : undefined,
  );
  return {
    id: r.id,
    kind,
    label,
    createdAt: r.createdAt,
    ...(typeof r.lastUsedAt === 'number' ? { lastUsedAt: r.lastUsedAt } : {}),
    ...(identity ? { identity } : {}),
  };
}

export function parseRegistry(raw: unknown, now: number): ParsedRegistry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: emptyRegistry(now), problem: 'corrupt' };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.accounts)) {
    return { state: emptyRegistry(now), problem: 'unsupported_version' };
  }
  let repaired = false;
  const seen = new Set<string>();
  const emails = new Set<string>();
  const accounts: ClaudeAccount[] = [];
  for (const entry of r.accounts) {
    const account = parseAccount(entry);
    const email = account ? emailKey(account.identity) : null;
    if (!account || seen.has(account.id) || (email && emails.has(email))) {
      repaired = true;
      continue;
    }
    seen.add(account.id);
    if (email) emails.add(email);
    accounts.push(account);
  }
  if (!seen.has(MASTER_ACCOUNT_ID)) accounts.unshift(masterAccount(now));
  else accounts.sort((a, b) => (a.kind === 'master' ? -1 : b.kind === 'master' ? 1 : 0));
  let activeAccountId = typeof r.activeAccountId === 'string' ? r.activeAccountId : MASTER_ACCOUNT_ID;
  if (!accounts.some((a) => a.id === activeAccountId)) {
    activeAccountId = MASTER_ACCOUNT_ID;
    repaired = true;
  }
  return { state: { version: 1, activeAccountId, accounts }, ...(repaired ? { problem: 'repaired' } : {}) };
}

// ── store ─────────────────────────────────────────────────────────────────────

export interface RegistryStore {
  load(): Promise<ClaudeAccountRegistryState>;
  save(state: ClaudeAccountRegistryState): Promise<void>;
}

export function createRegistryStore(options: {
  filePath: string;
  now?: () => number;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}): RegistryStore {
  const now = options.now ?? (() => Date.now());
  const { filePath } = options;
  // Saves are chained so a slower earlier write can never land after a later one.
  let chain: Promise<void> = Promise.resolve();

  async function load(): Promise<ClaudeAccountRegistryState> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry(now());
      throw err;
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    const parsed = parseRegistry(raw, now());
    if (parsed.problem === 'corrupt' || parsed.problem === 'unsupported_version') {
      const backup = `${filePath}.corrupt-${now()}`;
      await rename(filePath, backup);
      options.log?.warn('claude account registry unusable; kept aside', { problem: parsed.problem, backup });
    } else if (parsed.problem === 'repaired') {
      options.log?.warn('claude account registry had invalid entries; they were dropped', {});
    }
    return parsed.state;
  }

  function save(state: ClaudeAccountRegistryState): Promise<void> {
    const run = chain.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, filePath);
    });
    chain = run.catch(() => undefined);
    return run;
  }

  return { load, save };
}
