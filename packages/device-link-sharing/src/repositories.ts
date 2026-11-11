import { AppError } from './errors.js';
import type { SharedTaskRepository, StoredSharedTask, StoredSharedTaskInvitation } from './sharedTasks.js';
import type { ProviderShareRepository, StoredProviderShare, StoredProviderShareLink,
  StoredProviderShareRequest, StoredGuestCredential } from './providerShares.js';

export interface ResourceBinding { kind: 'shared-task' | 'provider-share'; resourceId: string; networkId: string; }
export interface SharingState {
  version: 1;
  tasks: StoredSharedTask[];
  invitations: StoredSharedTaskInvitation[];
  shares: StoredProviderShare[];
  links: StoredProviderShareLink[];
  requests: StoredProviderShareRequest[];
  credentials: StoredGuestCredential[];
  bindings: ResourceBinding[];
}
export const emptySharingState = (): SharingState => ({ version: 1, tasks: [], invitations: [], shares: [],
  links: [], requests: [], credentials: [], bindings: [] });
/** The host supplies a single-writer, durable transaction. Values returned by
 * read and transaction are snapshots, never mutable references to committed state. */
export interface SharingStorage {
  read(): SharingState;
  revision?(): unknown;
  transaction<T>(work: (draft: SharingState) => Promise<T>): Promise<T>;
}
function replace<T>(rows: T[], value: T, matches: (row: T) => boolean): void {
  const at = rows.findIndex(matches);
  if (at < 0) rows.push(structuredClone(value)); else rows[at] = structuredClone(value);
}
export function createSharingRepositories(storage: SharingStorage, creationNetworkId?: string): {
  tasks: SharedTaskRepository; providers: ProviderShareRepository;
} {
  const bind = (s: SharingState, kind: ResourceBinding['kind'], resourceId: string) => {
    if (s.bindings.some(b => b.kind === kind && b.resourceId === resourceId)) return;
    if (!creationNetworkId) throw new AppError('PERMISSION_DENIED', 403, 'A certified host is required');
    s.bindings.push({ kind, resourceId, networkId: creationNetworkId });
  };
  const tasks: SharedTaskRepository = {
    async listActivePage(after, limit) { return storage.read().tasks.filter(t => t.status === 'active' && (!after || t.sharedTaskId > after))
      .sort((a,b) => a.sharedTaskId.localeCompare(b.sharedTaskId)).slice(0, limit); },
    async find(id) { return storage.read().tasks.find(t => t.sharedTaskId === id) ?? null; },
    async findInvitation(digest) { return storage.read().invitations.find(i => i.digest === digest) ?? null; },
    async listForActor(actor) { return storage.read().tasks.filter(t => t.ownerAccountId === actor.accountId
      || t.guests.some(g => g.accountId === actor.accountId && g.status === 'joined')); },
    transaction(owner, work, guestAccountId) { return storage.transaction(async s => work({
      async get(id) { return s.tasks.find(t => t.sharedTaskId === id && t.ownerAccountId === owner) ?? null; },
      async listActive() { return s.tasks.filter(t => t.ownerAccountId === owner && t.status === 'active'); },
      async countJoinedActive() {
        if (guestAccountId === undefined) throw new AppError('PERMISSION_DENIED', 403, 'Guest account required');
        return s.tasks.filter(t => t.status === 'active' && t.guests.some(g => g.accountId === guestAccountId && g.status === 'joined')).length;
      },
      async save(task) {
        if (task.ownerAccountId !== owner) throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
        bind(s, 'shared-task', task.sharedTaskId); replace(s.tasks, task, row => row.sharedTaskId === task.sharedTaskId);
      },
      async invite(invite) {
        if (invite.ownerAccountId !== owner || !s.tasks.some(t => t.sharedTaskId === invite.sharedTaskId && t.ownerAccountId === owner))
          throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
        replace(s.invitations, invite, row => row.digest === invite.digest);
      },
    })); },
  };
  const ownerOf = (s: SharingState, id: string) => s.shares.find(p => p.shareId === id)?.ownerAccountId;
  const providers: ProviderShareRepository = {
    async findShare(id) { return storage.read().shares.find(p => p.shareId === id) ?? null; },
    async findLink(digest) { const s = storage.read(), row = s.links.find(p => p.digest === digest);
      return row ? { ...row, ownerAccountId: ownerOf(s, row.shareId)! } : null; },
    async findRequest(id) { const s = storage.read(), row = s.requests.find(p => p.requestId === id);
      return row ? { ...row, ownerAccountId: ownerOf(s, row.shareId)! } : null; },
    async findMember(id) { const p = storage.read().shares.find(p => p.members.some(m => m.memberId === id));
      return p ? { shareId: p.shareId, ownerAccountId: p.ownerAccountId } : null; },
    async listOwnerShares(owner, device) { const s = storage.read();
      return s.shares.filter(p => p.status === 'active' && p.ownerAccountId === owner && p.hostDeviceId === device)
        .map(share => ({ share, requests: s.requests.filter(r => r.shareId === share.shareId && r.status === 'pending') })); },
    async listReceived(guest) { return storage.read().shares.filter(p => p.status === 'active'
      && p.members.some(m => m.guestKey === guest && (m.status === 'active' || m.status === 'paused'))); },
    transaction(owner, work) { return storage.transaction(async s => {
      const owns = (id: string) => ownerOf(s, id) === owner;
      return work({
        async getShare(id) { return s.shares.find(p => p.shareId === id && p.ownerAccountId === owner) ?? null; },
        async findActiveShare(device, provider) { return s.shares.find(p => p.status === 'active' && p.ownerAccountId === owner
          && p.hostDeviceId === device && p.providerId === provider) ?? null; },
        async saveShareProfile(share) {
          if (share.ownerAccountId !== owner) throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
          bind(s, 'provider-share', share.shareId);
          const members = s.shares.find(p => p.shareId === share.shareId)?.members ?? [];
          replace(s.shares, { ...share, members }, p => p.shareId === share.shareId);
        },
        async saveMember(share, member) {
          const stored = s.shares.find(p => p.shareId === share.shareId && p.ownerAccountId === owner);
          if (!stored || share.ownerAccountId !== owner) throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
          replace(stored.members, member, m => m.memberId === member.memberId);
        },
        async getLink(digest) { return s.links.find(l => l.digest === digest && owns(l.shareId)) ?? null; },
        async insertLink(link) {
          if (!owns(link.shareId)) throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
          if (s.links.some(l => l.digest === link.digest)) throw new AppError('CONFLICT', 409, 'Link already exists');
          s.links.push(structuredClone(link));
        },
        async closeLink(digest, state) { const link = s.links.find(l => l.digest === digest && owns(l.shareId));
          if (link?.state === 'requested') link.state = state; },
        async claimLink(digest, now) {
          const link = s.links.find(l => l.digest === digest && owns(l.shareId));
          if (!link || link.state !== 'unused' || link.expiresAt <= now) return false;
          link.state = 'requested'; return true;
        },
        async getRequest(id) { return s.requests.find(r => r.requestId === id && owns(r.shareId)) ?? null; },
        async getRequestByLink(digest) { return s.requests.find(r => r.linkDigest === digest && owns(r.shareId)) ?? null; },
        async insertRequest(request) {
          if (!owns(request.shareId)) throw new AppError('PERMISSION_DENIED', 403, 'Owner mismatch');
          if (s.requests.some(r => r.linkDigest === request.linkDigest || r.requestId === request.requestId))
            throw new AppError('PROVIDER_SHARE_LINK_USED', 409, 'Link already used');
          s.requests.push(structuredClone(request));
        },
        async decidePendingRequest(id, now, decision) {
          const request = s.requests.find(r => r.requestId === id && owns(r.shareId));
          if (!request || request.status !== 'pending' || request.expiresAt <= now) return false;
          Object.assign(request, { status: decision.status, memberId: decision.memberId ?? null, decidedAt: now }); return true;
        },
        async rotatePendingRequestToken(id, now, token) {
          const request = s.requests.find(r => r.requestId === id && owns(r.shareId));
          if (!request || request.status !== 'pending' || request.expiresAt <= now) return false;
          request.requestTokenDigest = token; return true;
        },
      });
    }); },
    expire(now) { return storage.transaction(async s => {
      let links = 0, requests = 0;
      for (const r of s.requests) if (r.status === 'pending' && r.expiresAt <= now) {
        r.status = 'expired'; r.decidedAt = now; requests++;
        const link = s.links.find(l => l.digest === r.linkDigest); if (link?.state === 'requested') link.state = 'expired';
      }
      for (const l of s.links) if (l.state === 'unused' && l.expiresAt <= now) { l.state = 'expired'; links++; }
      return { links, requests };
    }); },
    purge(before) { return storage.transaction(async s => {
      const links = s.links.length, requests = s.requests.length;
      s.requests = s.requests.filter(r => r.status === 'pending' || r.expiresAt >= before);
      s.links = s.links.filter(l => l.state === 'requested' || l.expiresAt >= before);
      s.credentials = s.credentials.filter(c => c.expiresAt >= before);
      return { links: links - s.links.length, requests: requests - s.requests.length };
    }); },
    async hasActiveMember(guest) { return storage.read().shares.some(p => p.status === 'active'
      && p.members.some(m => m.guestKey === guest && m.status === 'active')); },
    saveGuestCredential(credential) { return storage.transaction(async s => {
      replace(s.credentials, credential, c => c.guestKey === credential.guestKey && c.deviceId === credential.deviceId);
    }); },
    async findGuestCredential(digest) { return storage.read().credentials.find(c => c.digest === digest) ?? null; },
  };
  return { tasks, providers };
}
