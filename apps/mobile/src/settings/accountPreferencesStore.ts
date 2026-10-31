import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACCOUNT_PREFERENCES_SYNC_CHANNEL,
  editAccountPreferenceState,
  isProviderSharePeer,
  isSharedTaskPeer,
  mergeAccountPreferencesStates,
  normalizeAccountPreferenceValue,
  parseAccountPreferencesState,
  parseAccountPreferencesSyncFrame,
  type AccountPreferencesState,
  type AccountPreferencesSyncFrame,
} from '@cindy/device-link';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';

type MobilePreferenceKey = 'theme' | 'language';
type PendingLegacy = Partial<Record<MobilePreferenceKey, string>>;
type ChangeSource = 'load' | 'local' | 'remote';
type Listener = (values: Record<MobilePreferenceKey, string | null>, source: ChangeSource) => void;
const legacyKeys = {
  theme: 'cindy.mobile.theme-preference.v1',
  language: 'xdt-maker.mobile.language-preference.v1',
} as const;
const PREFIX = 'cindy.mobile.account-preferences.v1.';
const LEGACY_CLAIM_KEY = 'cindy.mobile.account-preferences.legacy-owner.v1';
const NODE_KEY = 'cindy.mobile.account-preferences.node.v1';
const keys: readonly MobilePreferenceKey[] = ['theme', 'language'];
const listeners = new Set<Listener>();
const queues = new Map<string, Promise<unknown>>();
let claimQueue: Promise<unknown> = Promise.resolve();
let nodeFlight: Promise<string> | null = null;

interface Context {
  owner: MobileAuthOwnerGeneration;
  state: AccountPreferencesState;
  pendingLegacy: PendingLegacy;
  loaded: boolean;
  loading: Promise<void> | null;
}
let active: Context | null = null;

function current(context: Context): boolean {
  return active === context && isMobileAuthOwnerCurrent(context.owner);
}

function values(context: Context | null): Record<MobilePreferenceKey, string | null> {
  return {
    theme: context?.state.fields.theme?.value ?? context?.pendingLegacy.theme ?? null,
    language: context?.state.fields.language?.value ?? context?.pendingLegacy.language ?? null,
  };
}

function emit(context: Context | null, source: ChangeSource): void {
  if (context && !current(context)) return;
  const next = values(context);
  for (const listener of listeners) listener(next, source);
}

function contextForOwner(): Context | null {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey) return null;
  if (active && active.owner.generation === owner.generation && active.owner.accountKey === owner.accountKey) return active;
  active = { owner, state: { version: 1, fields: {} }, pendingLegacy: {}, loaded: false, loading: null };
  return active;
}

function enqueue<T>(context: Context, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(context.owner.accountKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queues.set(context.owner.accountKey, next.catch(() => undefined));
  return next;
}

async function nodeId(): Promise<string> {
  if (!nodeFlight) {
    nodeFlight = (async () => {
      const stored = await AsyncStorage.getItem(NODE_KEY);
      if (stored && /^[A-Za-z0-9_-]{1,80}$/.test(stored)) return stored;
      const next = `mobile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      await AsyncStorage.setItem(NODE_KEY, next);
      return next;
    })().catch(error => { nodeFlight = null; throw error; });
  }
  return nodeFlight;
}

function persist(context: Context, state = context.state, pendingLegacy = context.pendingLegacy): Promise<void> {
  return AsyncStorage.setItem(PREFIX + context.owner.accountKey, JSON.stringify({ version: 1, state, pendingLegacy }));
}

async function claimLegacy(context: Context): Promise<PendingLegacy> {
  const claim = claimQueue.catch(() => undefined).then(async () => {
    const claimedBy = await AsyncStorage.getItem(LEGACY_CLAIM_KEY);
    if (!current(context) || (claimedBy !== null && claimedBy !== context.owner.accountKey)) return {};
    // A durable one-owner claim survives logout and prevents the same old
    // device-wide preferences from leaking into every later account.
    if (claimedBy === null) await AsyncStorage.setItem(LEGACY_CLAIM_KEY, context.owner.accountKey);
    if (!current(context)) return {};
    const pending: PendingLegacy = {};
    for (const key of keys) {
      const raw = await AsyncStorage.getItem(legacyKeys[key]);
      const value = normalizeAccountPreferenceValue(key, raw);
      if (typeof value === 'string' && value !== 'system') pending[key] = value;
    }
    return pending;
  });
  claimQueue = claim.catch(() => undefined);
  return claim;
}

async function load(context: Context): Promise<void> {
  if (context.loaded) return;
  if (context.loading) return context.loading;
  context.loading = (async () => {
    await (queues.get(context.owner.accountKey) ?? Promise.resolve());
    if (!current(context)) return;
    const raw = await AsyncStorage.getItem(PREFIX + context.owner.accountKey);
    if (!current(context)) return;
    if (raw !== null) {
      const record = JSON.parse(raw) as { version?: unknown; state?: unknown; pendingLegacy?: unknown };
      const parsed = parseAccountPreferencesState(record.state);
      if (record.version !== 1 || !parsed || !record.pendingLegacy || typeof record.pendingLegacy !== 'object'
        || Array.isArray(record.pendingLegacy)) throw new Error('Invalid account preferences');
      const pending: PendingLegacy = {};
      for (const key of keys) {
        const value = (record.pendingLegacy as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const normalized = normalizeAccountPreferenceValue(key, value);
        if (typeof normalized !== 'string' || normalized === 'system') throw new Error('Invalid legacy account preference');
        if (!parsed.fields[key]) pending[key] = normalized;
      }
      context.state = parsed;
      context.pendingLegacy = pending;
    } else {
      context.pendingLegacy = await claimLegacy(context);
      if (!current(context)) return;
      await persist(context);
    }
    if (!current(context)) return;
    context.loaded = true;
    emit(context, 'load');
  })().finally(() => { context.loading = null; });
  return context.loading;
}

subscribeMobileAuthOwner(() => {
  active = null;
  const context = contextForOwner();
  emit(context, 'load');
  if (context) void load(context).catch(() => undefined);
});

export function subscribeMobileAccountPreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function readMobileAccountPreference(key: MobilePreferenceKey): Promise<string | null> {
  const owner = getMobileAuthOwner();
  if (owner.switching) return null;
  const context = contextForOwner();
  if (!context) {
    const raw = await AsyncStorage.getItem(legacyKeys[key]).catch(() => null);
    if (!isMobileAuthOwnerCurrent(owner)) return readMobileAccountPreference(key);
    return normalizeAccountPreferenceValue(key, raw) ?? null;
  }
  await load(context).catch(() => undefined);
  if (!current(context)) return readMobileAccountPreference(key);
  return values(context)[key];
}

export async function saveMobileAccountPreference(key: MobilePreferenceKey, raw: string | null): Promise<void> {
  const normalized = normalizeAccountPreferenceValue(key, raw);
  if (normalized === undefined) throw new Error('Invalid account preference');
  const value = normalized === 'system' ? null : normalized;
  const owner = getMobileAuthOwner();
  if (owner.switching) throw new Error('Account switch in progress');
  const context = contextForOwner();
  if (!context) {
    if (value === null) await AsyncStorage.removeItem(legacyKeys[key]);
    else await AsyncStorage.setItem(legacyKeys[key], value);
    const rawValues = await Promise.all(keys.map(item => AsyncStorage.getItem(legacyKeys[item])));
    if (isMobileAuthOwnerCurrent(owner)) {
      const next = {
        theme: normalizeAccountPreferenceValue('theme', rawValues[0]) ?? null,
        language: normalizeAccountPreferenceValue('language', rawValues[1]) ?? null,
      };
      for (const listener of listeners) listener(next, 'local');
    }
    return;
  }
  await load(context);
  const identity = await nodeId();
  await enqueue(context, async () => {
    if (!current(context)) return;
    const edited = editAccountPreferenceState(context.state, { key, value, nodeId: identity, counter: 0 });
    if (!edited) throw new Error('Account preference revision unavailable');
    const pending = { ...context.pendingLegacy };
    delete pending[key];
    await persist(context, edited.state, pending);
    if (!current(context)) return;
    context.state = edited.state;
    context.pendingLegacy = pending;
    emit(context, 'local');
  });
}

/** One authenticated relay generation. Known peers are learned from its own
 * account roster/presence, independently of the remote-control switch. */
export function createMobileAccountPreferencesSync(options: {
  isCurrent: () => boolean;
  isRevoked: (deviceId: string) => boolean;
  selfDeviceId: () => string | null;
  send: (deviceId: string, channel: string, frame: AccountPreferencesSyncFrame) => void;
}) {
  const context = contextForOwner();
  const peers = new Map<string, boolean>();
  let online = false;
  let disposed = false;
  const eligible = (deviceId: string) => !!context && current(context) && options.isCurrent() && !disposed && online
    && peers.get(deviceId) === true && deviceId !== options.selfDeviceId()
    && !isSharedTaskPeer(deviceId) && !isProviderSharePeer(deviceId) && !options.isRevoked(deviceId);
  const send = async (deviceId: string, requestReply = false) => {
    if (!context || !eligible(deviceId)) return;
    await load(context);
    if (!eligible(deviceId)) return;
    options.send(deviceId, ACCOUNT_PREFERENCES_SYNC_CHANNEL, {
      version: 1, dataOwnerId: context.owner.accountId, state: context.state,
      ...(requestReply ? { requestReply: true } : {}),
    });
  };
  const broadcast = (requestReply = false) => {
    for (const [deviceId] of peers) void send(deviceId, requestReply).catch(() => undefined);
  };
  const off = subscribeMobileAccountPreferences((_values, source) => {
    if (source === 'local') broadcast();
  });
  return {
    setOnline(next: boolean): void {
      const reconnecting = next && !online;
      online = next;
      if (reconnecting) broadcast(true);
    },
    peer(deviceId: string, peerOnline: boolean): void {
      const previous = peers.get(deviceId);
      peers.set(deviceId, peerOnline);
      if (peerOnline && previous !== true) void send(deviceId, true).catch(() => undefined);
    },
    async receive(deviceId: string, raw: unknown): Promise<void> {
      if (!context || !eligible(deviceId)) return;
      const frame = parseAccountPreferencesSyncFrame(raw);
      if (!frame || frame.dataOwnerId !== context.owner.accountId) return;
      await load(context);
      const identity = await nodeId();
      let changed = false;
      await enqueue(context, async () => {
        if (!eligible(deviceId)) return;
        const merged = mergeAccountPreferencesStates(context.state, frame.state);
        let next = merged.state;
        changed = merged.changed;
        // Import only after an authenticated peer's state has had first choice.
        // Until then these explicit old values remain a local display fallback.
        for (const key of keys) {
          const legacy = context.pendingLegacy[key];
          if (legacy === undefined || next.fields[key]) continue;
          const edited = editAccountPreferenceState(next, { key, value: legacy, nodeId: identity, counter: 0 });
          if (!edited) throw new Error('Account preference revision unavailable');
          next = edited.state;
          changed ||= edited.changed;
        }
        if (changed || Object.keys(context.pendingLegacy).length > 0) {
          await persist(context, next, {});
          if (!current(context)) return;
          context.state = next;
          context.pendingLegacy = {};
          emit(context, 'remote');
        }
      });
      if (!eligible(deviceId)) return;
      if (changed) broadcast();
      else if (frame.requestReply) await send(deviceId);
    },
    dispose(): void { disposed = true; off(); peers.clear(); },
  };
}

export const mobileAccountPreferencesTesting = {
  legacyKeys,
  legacyClaimKey: LEGACY_CLAIM_KEY,
  storageKey: (accountKey: string) => PREFIX + accountKey,
  async reset(): Promise<void> {
    active = null;
    await Promise.all([...queues.values(), claimQueue]);
    queues.clear();
    nodeFlight = null;
  },
};
