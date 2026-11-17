import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Delegation, DelegationRequest, DeviceCertificate, JoinRequest, PushRegistration, DeviceMetadata, SharingOrigins } from '@cindy/agent-net-protocol';
import { MAX_MEDIA_OBJECT_BYTES } from '@cindy/agent-net-protocol';
import { emptySharingState, type SharingState, type SharingStorage } from '@cindy/device-link-sharing/repositories';
import type { TenantJoinRequest } from './identity.js';

export interface DeviceRecord { certificate: DeviceCertificate; name: string; revokedAt: number | null; notBefore?: number;
  metadata?: DeviceMetadata; lastSeenAt?: number; reportedName?: string; customName?: string | null; }
export interface PendingJoin { request: JoinRequest; pollHash: string; expiresAt: number; status: 'pending' | 'approved' | 'rejected'; certificate?: DeviceCertificate; }
export interface MediaRecord { owner: string; recipient: string; size: number; received: number; expiresAt: number; }
export interface NetworkRecord {
  id: string; name: string; rootPublicKey: string; subject: string;
  devices: Record<string, DeviceRecord>;
  joinCodes: Record<string, { expiresAt: number; used: boolean }>;
  joins: Record<string, PendingJoin>;
  grants: Record<string, { delegation: Delegation; revokedAt: number | null }>;
  pushTokens: Record<string, PushRegistration>;
  media: Record<string, MediaRecord>;
  sharingOrigins?: Record<string, SharingOrigins>;
  /** Present only on a guest account's network hosted on a shared self-hosted relay. */
  tenant?: { accountName: string; createdAt: number };
}
export interface TenantRequestRecord { request: TenantJoinRequest; pollHash: string; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'rejected'; }
export interface State { schema: 1; networks: Record<string, NetworkRecord>; sharing?: SharingState; delegationRequests?: DelegationRequest[];
  /** The self-hosted relay owner's network; only its owner devices administer tenants. */
  primaryNetworkId?: string;
  /** Keyed by sha256(invite code); the code itself is never stored. */
  tenantInvites?: Record<string, { expiresAt: number; used: boolean }>;
  tenantRequests?: Record<string, TenantRequestRecord>; }
/** Reads return snapshots; a transaction commits its draft atomically or not at all. */
export interface RelayStore {
  network(id: string): NetworkRecord | undefined;
  networks(): NetworkRecord[];
  delegationRequests(): DelegationRequest[];
  primaryNetworkId(): string | undefined;
  tenantRequests(): TenantRequestRecord[];
  sharingStorage(): SharingStorage;
  transaction<T>(update: (state: State) => T | Promise<T>): Promise<T>;
  settled(): Promise<void>;
}
/** One relay process: the whole state in one atomically replaced file. */
export class Store implements RelayStore {
  private state: State;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly filename: string, state: State) { this.state = state; }
  static async open(dataDir: string): Promise<Store> {
    if (!path.isAbsolute(dataDir)) throw new Error('DATA_DIR_MUST_BE_ABSOLUTE');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, 'agent-net-state.json');
    let state: State = { schema: 1, networks: Object.create(null) };
    try {
      const parsed = JSON.parse(await readFile(filename, 'utf8')) as State;
      if (parsed.schema !== 1 || !parsed.networks || typeof parsed.networks !== 'object' || Array.isArray(parsed.networks)) throw new Error('INVALID_AGENT_NET_STATE');
      for (const [id, n] of Object.entries(parsed.networks)) {
        if (!n || n.id !== id || !n.devices || !n.joins || !n.joinCodes || !n.grants || typeof n.rootPublicKey !== 'string') throw new Error('INVALID_AGENT_NET_STATE');
        if (n.tenant !== undefined && (!n.tenant || typeof n.tenant.accountName !== 'string' || !Number.isSafeInteger(n.tenant.createdAt))) throw new Error('INVALID_AGENT_NET_STATE');
        n.pushTokens ??= {};
        n.media ??= {};
        for (const [mediaId, m] of Object.entries(n.media)) {
          if (!/^[a-f0-9-]{36}$/.test(mediaId) || !Number.isSafeInteger(m.size) || !Number.isSafeInteger(m.received)
            || m.size < 1 || m.size > MAX_MEDIA_OBJECT_BYTES || m.received < 0 || m.received > m.size) throw new Error('INVALID_AGENT_NET_STATE');
        }
      }
      state = parsed;
      if (state.sharing && (state.sharing.version !== 1 || ['tasks', 'invitations', 'shares', 'links', 'requests', 'credentials', 'bindings']
        .some(key => !Array.isArray((state.sharing as unknown as Record<string, unknown>)[key])))) throw new Error('INVALID_AGENT_NET_SHARING_STATE');
      if (state.delegationRequests && !Array.isArray(state.delegationRequests)) throw new Error('INVALID_AGENT_NET_DELEGATION_REQUESTS');
      const map = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value));
      if ((state.primaryNetworkId !== undefined && typeof state.primaryNetworkId !== 'string')
        || !map(state.tenantInvites) || !map(state.tenantRequests)) throw new Error('INVALID_AGENT_NET_TENANT_STATE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new Store(filename, state);
  }
  network(id: string): NetworkRecord | undefined { return Object.hasOwn(this.state.networks, id) ? structuredClone(this.state.networks[id]) : undefined; }
  networks(): NetworkRecord[] { return Object.values(structuredClone(this.state.networks)); }
  delegationRequests(): DelegationRequest[] { return structuredClone(this.state.delegationRequests ?? []); }
  primaryNetworkId(): string | undefined { return this.state.primaryNetworkId; }
  tenantRequests(): TenantRequestRecord[] { return Object.values(structuredClone(this.state.tenantRequests ?? {})); }
  sharingStorage(): SharingStorage {
    return { read: () => structuredClone(this.state.sharing ?? emptySharingState()), revision: () => this.revision,
      transaction: work => this.transaction(async state => {
        const sharing = state.sharing ??= emptySharingState();
        return work(sharing);
      }) };
  }
  async transaction<T>(update: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await update(draft);
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(draft), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, this.filename);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.state = draft;
      this.revision++;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async settled(): Promise<void> { await this.queue; }
}
