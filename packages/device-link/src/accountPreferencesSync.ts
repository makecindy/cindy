import { byteLength } from './transport.js';

/** Account preferences are a small, explicit replica, never arbitrary application settings. */
export const ACCOUNT_PREFERENCES_SYNC_CHANNEL = 'device-link:account-preferences:sync:v1';
export const ACCOUNT_PREFERENCES_MAX_BYTES = 16 * 1024;
export const ACCOUNT_PREFERENCE_KEYS = [
  'theme',
  'language',
  'sidebar.cardMode',
  'sidebar.mainListMode',
  'cc-agent.sidebar.filter.groupBy',
  'cc-agent.sidebar.filter.groupDialogue',
  'cc-agent.sidebar.filter.groupDevice',
  'cc-agent.sidebar.filter.sortBy',
  'cc-agent.sidebar.filter.taskInfo',
] as const;

export type AccountPreferenceKey = (typeof ACCOUNT_PREFERENCE_KEYS)[number];
/** null is a durable reset tombstone, not an absent event. */
export type AccountPreferenceValue = string | null;
export type AccountPreferenceValues = Partial<Record<AccountPreferenceKey, AccountPreferenceValue>>;
export interface AccountPreferenceRegister {
  value: AccountPreferenceValue;
  counter: number;
  nodeId: string;
}
export interface AccountPreferencesState {
  version: 1;
  fields: Partial<Record<AccountPreferenceKey, AccountPreferenceRegister>>;
}
export interface AccountPreferencesSyncFrame {
  version: 1;
  dataOwnerId: string;
  state: AccountPreferencesState;
  requestReply?: boolean;
}

const keySet = new Set<string>(ACCOUNT_PREFERENCE_KEYS);
const taskInfoSet = new Set(['time', 'pr', 'worktree', 'tokens', 'cost']);
const valuesByKey: Partial<Record<AccountPreferenceKey, readonly string[]>> = {
  theme: ['light', 'dark', 'system'],
  language: ['system', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR'],
  'sidebar.cardMode': ['text', 'card', 'list'],
  'sidebar.mainListMode': ['text', 'list'],
  'cc-agent.sidebar.filter.groupBy': ['project', 'flat'],
  'cc-agent.sidebar.filter.groupDialogue': ['true', 'false'],
  'cc-agent.sidebar.filter.groupDevice': ['true', 'false'],
  'cc-agent.sidebar.filter.sortBy': ['recency', 'created', 'priority'],
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function isAccountPreferenceKey(value: unknown): value is AccountPreferenceKey {
  return typeof value === 'string' && keySet.has(value);
}

export function isAccountPreferencesNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/** Undefined means invalid. JSON arrays are canonicalized without changing their user-chosen order. */
export function normalizeAccountPreferenceValue(
  key: AccountPreferenceKey,
  value: unknown,
): AccountPreferenceValue | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 128) return undefined;
  if (key !== 'cc-agent.sidebar.filter.taskInfo') {
    return valuesByKey[key]?.includes(value) ? value : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > taskInfoSet.size) return undefined;
    if (parsed.some(item => typeof item !== 'string' || !taskInfoSet.has(item))) return undefined;
    if (new Set(parsed).size !== parsed.length) return undefined;
    return JSON.stringify(parsed);
  } catch { return undefined; }
}

export function parseAccountPreferenceValues(raw: unknown): AccountPreferenceValues | null {
  const source = record(raw);
  if (!source || Object.keys(source).some(key => !isAccountPreferenceKey(key))) return null;
  const values: AccountPreferenceValues = {};
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = normalizeAccountPreferenceValue(key, source[key]);
    if (value === undefined) return null;
    values[key] = value;
  }
  return values;
}

export function parseAccountPreferencesState(raw: unknown): AccountPreferencesState | null {
  const source = record(raw);
  const fields = record(source?.fields);
  if (!source || source.version !== 1 || !fields) return null;
  if (Object.keys(source).some(key => key !== 'version' && key !== 'fields')) return null;
  if (Object.keys(fields).some(key => !isAccountPreferenceKey(key))) return null;
  const next: AccountPreferencesState = { version: 1, fields: {} };
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    if (!Object.hasOwn(fields, key)) continue;
    const field = record(fields[key]);
    if (!field || Object.keys(field).some(item => !['value', 'counter', 'nodeId'].includes(item))) return null;
    const value = normalizeAccountPreferenceValue(key, field.value);
    if (value === undefined || !Number.isSafeInteger(field.counter) || (field.counter as number) < 1
      || !isAccountPreferencesNodeId(field.nodeId)) return null;
    next.fields[key] = { value, counter: field.counter as number, nodeId: field.nodeId };
  }
  return next;
}

export function parseAccountPreferencesSyncFrame(raw: unknown): AccountPreferencesSyncFrame | null {
  const source = record(raw);
  if (!source || source.version !== 1 || typeof source.dataOwnerId !== 'string'
    || !source.dataOwnerId || source.dataOwnerId.length > 256
    || (source.requestReply !== undefined && typeof source.requestReply !== 'boolean')) return null;
  if (Object.keys(source).some(key => !['version', 'dataOwnerId', 'state', 'requestReply'].includes(key))) return null;
  try {
    if (byteLength(JSON.stringify(source)) > ACCOUNT_PREFERENCES_MAX_BYTES) return null;
  } catch { return null; }
  const state = parseAccountPreferencesState(source.state);
  return state ? {
    version: 1, dataOwnerId: source.dataOwnerId, state,
    ...(source.requestReply !== undefined ? { requestReply: source.requestReply } : {}),
  } : null;
}

function compareRegisters(a: AccountPreferenceRegister, b: AccountPreferenceRegister): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  // A cloned disk could reuse an identity/revision. Resolve even that collision deterministically.
  const av = JSON.stringify(a.value);
  const bv = JSON.stringify(b.value);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/** Per-field Lamport LWW: concurrent independent edits survive; no wall clock is trusted. */
export function mergeAccountPreferencesStates(
  local: AccountPreferencesState,
  remote: AccountPreferencesState,
): { state: AccountPreferencesState; changed: boolean } {
  const state: AccountPreferencesState = { version: 1, fields: {} };
  let changed = false;
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    const a = local.fields[key];
    const b = remote.fields[key];
    const winner = b && (!a || compareRegisters(b, a) > 0) ? b : a;
    if (winner) state.fields[key] = { ...winner };
    if (winner !== a) changed = true;
  }
  return { state, changed };
}

export function accountPreferencesCounter(state: AccountPreferencesState): number {
  return Math.max(0, ...Object.values(state.fields).map(field => field!.counter));
}

/** Apply a local edit using a persisted node identity/clock. Null means invalid input or clock exhaustion. */
export function editAccountPreferenceState(
  state: AccountPreferencesState,
  edit: { key: AccountPreferenceKey; value: AccountPreferenceValue; nodeId: string; counter: number },
): { state: AccountPreferencesState; counter: number; changed: boolean } | null {
  if (!isAccountPreferenceKey(edit.key) || !isAccountPreferencesNodeId(edit.nodeId)
    || !Number.isSafeInteger(edit.counter) || edit.counter < 0) return null;
  const value = normalizeAccountPreferenceValue(edit.key, edit.value);
  if (value === undefined) return null;
  const counter = Math.max(edit.counter, accountPreferencesCounter(state));
  const previous = state.fields[edit.key];
  if (previous && previous.value === value) return { state, counter, changed: false };
  if (counter >= Number.MAX_SAFE_INTEGER) return null;
  return {
    state: { version: 1, fields: { ...state.fields, [edit.key]: { value, nodeId: edit.nodeId, counter: counter + 1 } } },
    counter: counter + 1,
    changed: true,
  };
}

export function materializeAccountPreferences(state: AccountPreferencesState): AccountPreferenceValues {
  const values: AccountPreferenceValues = {};
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    const field = state.fields[key];
    if (field) values[key] = field.value;
  }
  return values;
}
