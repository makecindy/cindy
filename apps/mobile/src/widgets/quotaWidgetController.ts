import { emptyQuotaSnapshot, record, sanitizeQuotaSnapshot, type QuotaSnapshot } from './quotaSnapshot';
import { readWidgetQuota, type WidgetAccount, type WidgetQuotaReader } from './readWidgetQuota';

export interface QuotaWidgetState {
  ready: boolean;
  deviceId: string | null;
  snapshot: QuotaSnapshot;
  accounts: WidgetAccount[];
  busy: boolean;
  error: boolean;
  clearPending: boolean;
}
interface Storage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
interface NativeSnapshot { writeSnapshot(json: string): void; clearSnapshot(): void }
const empty = (): QuotaWidgetState => ({ ready: false, deviceId: null, snapshot: emptyQuotaSnapshot(), accounts: [], busy: false, error: false, clearPending: false });

/** Owns one user's selection and serialized writes. Native writes are synchronous at the owner fence. */
export class QuotaWidgetController {
  private state = empty();
  private owner = '';
  private epoch = 0;
  private writes = Promise.resolve();
  private flight: { epoch: number; promise: Promise<void> } | null = null;
  private listeners = new Set<() => void>();
  constructor(private storage: Storage, private native: NativeSnapshot, private isDeviceRevoked: (id: string) => boolean = () => false) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<QuotaWidgetState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private key(owner = this.owner) { return `cindy.quotaWidget.v1.${owner}`; }
  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => undefined);
    return pending;
  }
  private clearNative(): boolean {
    try { this.native.clearSnapshot(); this.publish({ clearPending: false }); return true; }
    catch { this.publish({ error: true, clearPending: true }); return false; }
  }
  async setOwner(owner: string): Promise<void> {
    const previous = this.owner;
    this.owner = owner;
    const epoch = ++this.epoch;
    this.state = empty();
    this.publish({ error: !this.clearNative() });
    // Switch/logout removes the previous account's selection and cache. Cold start may restore its own cache.
    if (previous) await this.serialize(() => this.storage.removeItem(this.key(previous))).catch(() => { if (epoch === this.epoch) this.publish({ error: true }); });
    if (epoch !== this.epoch) return;
    if (!owner) { this.publish({ ready: true }); return; }
    try {
      await this.serialize(async () => {
        const stored = await this.storage.getItem(this.key(owner));
        if (epoch !== this.epoch) return;
        const value = stored && stored.length <= 16384 ? record(JSON.parse(stored)) : {};
        const cachedDevice = typeof value.deviceId === 'string' && value.deviceId.length > 0 && value.deviceId.length <= 200 ? value.deviceId : null;
        // Revocation may arrive while this read is pending, before a selected device exists.
        const deviceId = cachedDevice && !this.isDeviceRevoked(cachedDevice) ? cachedDevice : null;
        const snapshot = sanitizeQuotaSnapshot(value.snapshot);
        snapshot.connection = 'offline';
        // Only the already authenticated owner may rehydrate a native snapshot.
        this.native.writeSnapshot(JSON.stringify(deviceId ? snapshot : emptyQuotaSnapshot()));
        this.publish({ deviceId, snapshot: deviceId ? snapshot : emptyQuotaSnapshot(), ready: true, clearPending: false });
        if (cachedDevice && !deviceId) await this.storage.removeItem(this.key(owner));
      });
    } catch { if (epoch === this.epoch) this.publish({ ready: true, error: true }); }
  }
  async selectDevice(deviceId: string | null): Promise<void> {
    if (!this.owner || (deviceId !== null && (!deviceId || deviceId.length > 200))) return;
    if (deviceId && this.isDeviceRevoked(deviceId)) return;
    if (deviceId === this.state.deviceId && !this.state.clearPending) return;
    const epoch = ++this.epoch;
    const cleared = this.clearNative();
    this.publish({ deviceId, snapshot: emptyQuotaSnapshot(), accounts: [], busy: false, error: !cleared });
    await this.persist(epoch);
  }
  private async persist(epoch: number) {
    const key = this.key();
    const value = JSON.stringify({ deviceId: this.state.deviceId, snapshot: this.state.snapshot });
    try {
      await this.serialize(async () => { if (epoch === this.epoch && this.owner) await this.storage.setItem(key, value); });
    } catch { if (epoch === this.epoch) this.publish({ error: true, clearPending: this.state.clearPending || this.state.deviceId === null }); }
  }
  /** Suspension is not a failed source read. Keep the last observation until it ages out. */
  suspend(): void {
    ++this.epoch;
    this.publish({ busy: false });
  }
  offline(): void {
    ++this.epoch;
    const snapshot = { ...this.state.snapshot, connection: 'offline' as const };
    try { this.native.writeSnapshot(JSON.stringify(snapshot)); this.publish({ snapshot, busy: false }); }
    catch { this.publish({ error: true, busy: false }); }
  }
  refresh(reader: WidgetQuotaReader): Promise<void> {
    if (!this.owner || !this.state.ready || !this.state.deviceId || this.state.clearPending) return Promise.resolve();
    if (this.isDeviceRevoked(this.state.deviceId)) return this.selectDevice(null);
    const epoch = this.epoch;
    if (this.flight?.epoch === epoch) return this.flight.promise;
    this.publish({ busy: true, error: false });
    const promise = (async () => {
      try {
        const result = await readWidgetQuota(reader);
        if (epoch !== this.epoch) return;
        if (this.state.deviceId && this.isDeviceRevoked(this.state.deviceId)) { await this.selectDevice(null); return; }
        // Retain only a transiently failed observation from this same owner/device epoch
        // and provider account. A cold-restored cache has no validated account list.
        const snapshot = { ...result.snapshot, rows: result.snapshot.rows.map(row => {
          const failed = result.transientFailures.find(account => account.platform === row.platform);
          if (!failed || !this.state.accounts.some(account => account.platform === failed.platform && account.providerId === failed.providerId)) return row;
          return this.state.snapshot.rows.find(previous => previous.platform === row.platform) ?? row;
        }) };
        this.native.writeSnapshot(JSON.stringify(snapshot));
        this.publish({ snapshot, accounts: result.accounts, busy: false, error: result.transientFailures.length > 0 });
        await this.persist(epoch);
      } catch {
        if (epoch !== this.epoch) return;
        this.offline();
        this.publish({ error: true });
      }
    })();
    this.flight = { epoch, promise };
    void promise.finally(() => { if (this.flight?.promise === promise) this.flight = null; });
    return promise;
  }
}
