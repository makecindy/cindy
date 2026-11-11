const OWNER_CLAIM_KEY = 'cc-agent.sidebar.identityOwnerClaim.v1';
const LEGACY_ENVELOPE_SCHEMA_VERSION = 1;
const PINNED_ORDER_KEY = 'cc-agent.sidebar.pinnedSessionOrder';

const LEGACY_SIDEBAR_KEYS = [
  'cc-agent.sidebar.filter.projects',
  'cc-agent.sidebar.filter.manualProjectOrder',
  'cc-agent.sidebar.collapsedProjects',
  'cc-agent.sidebar.collapsedAutomationGroups',
  'cc-agent.sidebar.selectedMachines',
  'cc-agent.sidebar.pinnedSessionOrder',
] as const;

type LegacySidebarKey = (typeof LEGACY_SIDEBAR_KEYS)[number];
type LegacySidebarValues = Record<LegacySidebarKey, string | null>;

interface LegacySidebarEnvelope {
  version: 1;
  ownerId: string;
  legacy: {
    schemaVersion: typeof LEGACY_ENVELOPE_SCHEMA_VERSION;
    values: LegacySidebarValues;
  };
}

interface OwnerAuthority {
  dataOwnerId: string;
  ownerGeneration: number;
  claimed: boolean;
  canInitialize: boolean;
  pinnedLegacyConsumed: boolean;
}

type OwnerAuthorityReader = (ownerId: string) => OwnerAuthority | null;

type ClaimState =
  | { kind: 'absent'; raw: null }
  | { kind: 'bare'; raw: string; ownerId: string }
  | { kind: 'envelope'; raw: string; envelope: LegacySidebarEnvelope }
  | { kind: 'malformed'; raw: string };

type ScopedWritePlan = 'blocked' | 'initialize-envelope' | 'write';

let ownerAuthorityReaderForTest: OwnerAuthorityReader | null = null;
let cachedMainAuthority: {
  token: number;
  requestedOwnerId: string;
  available: boolean;
  authority: OwnerAuthority | null;
} | null = null;
let mainAuthorityCacheToken = 0;

function clearMainAuthorityCache(): void {
  mainAuthorityCacheToken += 1;
  cachedMainAuthority = null;
}

function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function sidebarOwnerStorageKey(baseKey: string, ownerId: string): string {
  return `${baseKey}.owner.${encodeURIComponent(ownerId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacySidebarKey(value: string): value is LegacySidebarKey {
  return (LEGACY_SIDEBAR_KEYS as readonly string[]).includes(value);
}

function parseLegacyValues(value: unknown): LegacySidebarValues | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== LEGACY_SIDEBAR_KEYS.length || keys.some((key) => !isLegacySidebarKey(key))) {
    return null;
  }
  const parsed = {} as LegacySidebarValues;
  for (const key of LEGACY_SIDEBAR_KEYS) {
    const raw = value[key];
    if (raw !== null && typeof raw !== 'string') return null;
    parsed[key] = raw;
  }
  return parsed;
}

function parseClaimState(raw: string | null): ClaimState {
  if (raw === null) return { kind: 'absent', raw };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.ownerId !== 'string' ||
      parsed.ownerId.length === 0
    ) {
      return { kind: 'malformed', raw };
    }
    if (!Object.hasOwn(parsed, 'legacy')) {
      return { kind: 'bare', raw, ownerId: parsed.ownerId };
    }
    if (!isRecord(parsed.legacy) || parsed.legacy.schemaVersion !== 1) {
      return { kind: 'malformed', raw };
    }
    const values = parseLegacyValues(parsed.legacy.values);
    if (!values) return { kind: 'malformed', raw };
    return {
      kind: 'envelope',
      raw,
      envelope: {
        version: 1,
        ownerId: parsed.ownerId,
        legacy: {
          schemaVersion: LEGACY_ENVELOPE_SCHEMA_VERSION,
          values,
        },
      },
    };
  } catch {
    return { kind: 'malformed', raw };
  }
}

function readClaimState(storage: Storage): ClaimState {
  return parseClaimState(storage.getItem(OWNER_CLAIM_KEY));
}

function emptyLegacyValues(): LegacySidebarValues {
  return Object.fromEntries(LEGACY_SIDEBAR_KEYS.map((key) => [key, null])) as LegacySidebarValues;
}

function captureLegacyValues(
  storage: Storage,
  ownerId: string,
  authority: OwnerAuthority,
): LegacySidebarValues {
  return Object.fromEntries(
    LEGACY_SIDEBAR_KEYS.map((key) => [
      key,
      (key === PINNED_ORDER_KEY && authority.pinnedLegacyConsumed) ||
      (key !== PINNED_ORDER_KEY && storage.getItem(sidebarOwnerStorageKey(key, ownerId)) !== null)
        ? null
        : storage.getItem(key),
    ]),
  ) as LegacySidebarValues;
}

function readOwnerAuthority(ownerId: string, fresh = false): OwnerAuthority | null {
  if (fresh) clearMainAuthorityCache();
  if (ownerAuthorityReaderForTest) {
    const authority = ownerAuthorityReaderForTest(ownerId);
    return authority?.dataOwnerId === ownerId ? authority : null;
  }

  let available: boolean;
  let authority: OwnerAuthority | null;
  if (!fresh && cachedMainAuthority?.requestedOwnerId === ownerId) {
    available = cachedMainAuthority.available;
    authority = cachedMainAuthority.authority;
  } else {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI?.sidebarSettings;
    available = typeof api?.claimLegacyRendererOwner === 'function';
    try {
      const claim = api?.claimLegacyRendererOwner?.();
      authority =
        claim?.dataOwnerId && Number.isInteger(claim.ownerGeneration) && claim.ownerGeneration >= 0
          ? {
              dataOwnerId: claim.dataOwnerId,
              ownerGeneration: claim.ownerGeneration,
              claimed: claim.claimed,
              canInitialize: claim.canInitialize,
              pinnedLegacyConsumed: claim.pinnedLegacyConsumed,
            }
          : null;
    } catch {
      authority = null;
    }
    if (!fresh) {
      const token = ++mainAuthorityCacheToken;
      cachedMainAuthority = { token, requestedOwnerId: ownerId, available, authority };
      queueMicrotask(() => {
        if (cachedMainAuthority?.token === token) cachedMainAuthority = null;
      });
    }
  }
  if (available) return authority?.dataOwnerId === ownerId ? authority : null;

  // Renderer storage unit tests run without preload. Production renderer calls
  // always have the synchronous Main authority above.
  return import.meta.env.MODE === 'test'
    ? {
        dataOwnerId: ownerId,
        ownerGeneration: 0,
        claimed: true,
        canInitialize: true,
        pinnedLegacyConsumed: false,
      }
    : null;
}

function sameAuthority(left: OwnerAuthority, right: OwnerAuthority): boolean {
  return left.dataOwnerId === right.dataOwnerId && left.ownerGeneration === right.ownerGeneration;
}

/**
 * Decide the only safe transition before a first owner-scoped write.
 *
 * Existing scoped state is already authoritative. Otherwise an unresolved or
 * malformed shared claim must not be shadowed; a known foreign claim is safe
 * because its legacy snapshot can never belong to the current owner.
 */
function scopedWritePlan(
  state: ClaimState,
  ownerId: string,
  authority: OwnerAuthority,
  hasScopedValue: boolean,
): ScopedWritePlan {
  if (hasScopedValue) return 'write';

  switch (state.kind) {
    case 'absent':
      return authority.claimed && authority.canInitialize ? 'initialize-envelope' : 'blocked';
    case 'bare':
      if (state.ownerId !== ownerId) return 'write';
      return authority.claimed && authority.canInitialize ? 'initialize-envelope' : 'blocked';
    case 'envelope':
      if (state.envelope.ownerId !== ownerId) return 'write';
      return authority.claimed ? 'write' : 'blocked';
    case 'malformed':
      return 'blocked';
  }
}

function initializeLegacyEnvelope(
  storage: Storage,
  ownerId: string,
  previous: Extract<ClaimState, { kind: 'absent' | 'bare' }>,
  authorityBefore: OwnerAuthority,
): LegacySidebarEnvelope | null {
  if (!authorityBefore.claimed || !authorityBefore.canInitialize) return null;

  let values: LegacySidebarValues;
  try {
    // A bare v1 marker was written by an unreleased intermediate build. It
    // reserved an owner but did not record which roots were already consumed.
    // Upgrading it with an empty fallback avoids guessing that downgrade-era
    // unscoped writes belong to that owner.
    values =
      previous.kind === 'bare'
        ? emptyLegacyValues()
        : captureLegacyValues(storage, ownerId, authorityBefore);
  } catch {
    return null;
  }

  const envelope: LegacySidebarEnvelope = {
    version: 1,
    ownerId,
    legacy: {
      schemaVersion: LEGACY_ENVELOPE_SCHEMA_VERSION,
      values,
    },
  };
  const candidate = JSON.stringify(envelope);

  try {
    if (storage.getItem(OWNER_CLAIM_KEY) !== previous.raw) {
      const latest = readClaimState(storage);
      return latest.kind === 'envelope' && latest.envelope.ownerId === ownerId
        ? latest.envelope
        : null;
    }
    const authorityAtCommit = readOwnerAuthority(ownerId, true);
    if (
      !authorityAtCommit?.claimed ||
      !authorityAtCommit.canInitialize ||
      !sameAuthority(authorityBefore, authorityAtCommit)
    ) {
      return null;
    }

    storage.setItem(OWNER_CLAIM_KEY, candidate);
    const stored = readClaimState(storage);
    const authorityAfter = readOwnerAuthority(ownerId, true);
    if (
      stored.kind === 'envelope' &&
      stored.envelope.ownerId === ownerId &&
      authorityAfter?.claimed &&
      authorityAfter.canInitialize &&
      sameAuthority(authorityAtCommit, authorityAfter)
    ) {
      return stored.envelope;
    }
    return null;
  } catch {
    return null;
  }
}

function getLegacyEnvelope(
  storage: Storage,
  ownerId: string,
  authority: OwnerAuthority,
): LegacySidebarEnvelope | null {
  if (!authority.claimed) return null;
  let state: ClaimState;
  try {
    state = readClaimState(storage);
  } catch {
    return null;
  }
  if (state.kind === 'envelope') {
    return state.envelope.ownerId === ownerId ? state.envelope : null;
  }
  if (state.kind === 'malformed' || (state.kind === 'bare' && state.ownerId !== ownerId)) {
    return null;
  }
  return initializeLegacyEnvelope(storage, ownerId, state, authority);
}

/** Read scoped state first, then the immutable first-upgrade fallback. */
export function readSidebarOwnerStorage(baseKey: string, ownerId: string | null): string | null {
  if (!ownerId) return null;
  const storage = safeStorage();
  const authority = readOwnerAuthority(ownerId);
  if (!storage || !authority) return null;

  const envelope = getLegacyEnvelope(storage, ownerId, authority);
  try {
    const scoped = storage.getItem(sidebarOwnerStorageKey(baseKey, ownerId));
    if (scoped !== null) return scoped;
  } catch {
    return null;
  }
  return envelope && isLegacySidebarKey(baseKey) ? envelope.legacy.values[baseKey] : null;
}

export function writeSidebarOwnerStorage(
  baseKey: string,
  ownerId: string | null,
  value: string,
): boolean {
  if (!ownerId) return false;
  const storage = safeStorage();
  const authority = readOwnerAuthority(ownerId);
  if (!storage || !authority) return false;
  try {
    const state = readClaimState(storage);
    const scopedKey = sidebarOwnerStorageKey(baseKey, ownerId);
    const hasScopedValue = storage.getItem(scopedKey) !== null;
    const plan = scopedWritePlan(state, ownerId, authority, hasScopedValue);
    if (plan === 'blocked') return false;
    if (plan === 'initialize-envelope' && getLegacyEnvelope(storage, ownerId, authority) === null) {
      return false;
    }
    storage.setItem(scopedKey, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pinned order migrates to Main storage. The envelope keeps the captured bytes
 * durable until Main reports an authoritative owner-scoped snapshot.
 */
export function readClaimedLegacySidebarStorage(
  baseKey: string,
  ownerId: string | null,
): string | null {
  if (!ownerId) return null;
  const storage = safeStorage();
  const authority = readOwnerAuthority(ownerId);
  if (!storage || !authority?.claimed) return null;
  if (baseKey === PINNED_ORDER_KEY && authority.pinnedLegacyConsumed) return null;
  const envelope = getLegacyEnvelope(storage, ownerId, authority);
  return envelope && isLegacySidebarKey(baseKey) ? envelope.legacy.values[baseKey] : null;
}

export function clearClaimedLegacySidebarStorage(baseKey: string, ownerId: string | null): void {
  if (!ownerId) return;
  const storage = safeStorage();
  const authority = readOwnerAuthority(ownerId);
  if (!storage || !authority?.claimed) return;
  if (baseKey === PINNED_ORDER_KEY && !authority.pinnedLegacyConsumed) return;
  // Main's monotonic consumed bit makes the captured pin staging unreadable.
  // Keep the unscoped root untouched so a concurrently running parent release
  // never loses the compatibility state it still owns.
  getLegacyEnvelope(storage, ownerId, authority);
}

export const __testing = {
  OWNER_CLAIM_KEY,
  LEGACY_SIDEBAR_KEYS,
  setOwnerAuthorityReader(reader: OwnerAuthorityReader | null): void {
    clearMainAuthorityCache();
    ownerAuthorityReaderForTest = reader;
  },
};
