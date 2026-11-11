import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, conflict, invalidParams, notFound } from './errors.js';
import type { IdentityCardPurpose, IdentityCardVerifier, VerifiedPerson } from './identityCard.js';

/** Link lifetime: only bounds "open link → send request". */
export const PROVIDER_SHARE_LINK_TTL_MS = 5 * 60_000;
/** Request lifetime: the owner has 24 hours to decide. */
export const PROVIDER_SHARE_REQUEST_TTL_MS = 24 * 60 * 60_000;
/** Per-member device bindings, same bound as shared tasks. */
export const PROVIDER_SHARE_MAX_MEMBER_DEVICES = 64;
/** Cross-region guest connection credential lifetime (contract §6.2). */
export const PROVIDER_SHARE_GUEST_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;

/** Identity supplied exclusively by the verified access-token adapter. */
export interface ProviderShareActor { accountId: string; deviceId: string }
export type ProviderShareRegion = 'cn' | 'global';
/** Identity-card snapshot: nickname, picture and region only. */
export type PersonSnapshot = VerifiedPerson;

export type ProviderShareMemberStatus = 'active' | 'paused' | 'removed' | 'left';
export type ProviderShareLinkState = 'unused' | 'requested' | 'consumed' | 'rejected' | 'withdrawn' | 'expired';
export type ProviderShareRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';

export interface StoredProviderShareMember {
  memberId: string;
  /** Same region: the guest membershipId. Cross region (P3): `x:<region>:<sub>`. */
  guestKey: string;
  guest: PersonSnapshot;
  status: ProviderShareMemberStatus;
  version: number;
  deviceIds: string[];
  joinedAt: number;
}
export interface StoredProviderShare {
  shareId: string;
  ownerAccountId: string;
  hostDeviceId: string;
  providerId: string;
  providerLabel: string;
  deviceName: string;
  owner: PersonSnapshot;
  status: 'active' | 'deleted';
  createdAt: number;
  /** Includes tombstones; never delete a member row. */
  members: StoredProviderShareMember[];
}
export interface StoredProviderShareLink {
  digest: string;
  shareId: string;
  state: ProviderShareLinkState;
  createdAt: number;
  expiresAt: number;
}
export interface StoredProviderShareRequest {
  requestId: string;
  linkDigest: string;
  shareId: string;
  guestKey: string;
  guest: PersonSnapshot;
  pairingCode: string;
  status: ProviderShareRequestStatus;
  /** Cross-region only: digest of the one-time requestToken. */
  requestTokenDigest: string | null;
  memberId: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}
/** Cross-region guest connection credential; only the digest persists. */
export interface StoredGuestCredential {
  guestKey: string;
  /** Cross-region device id `x:<region>:<32 hex>`. */
  deviceId: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
}
/** Read-side lookups also return the owner so mutations can take the owner lock first. */
export type Owned<T> = T & { ownerAccountId: string };

export interface ProviderShareTransaction {
  /** Owner-scoped: returns null for another owner's share. */
  getShare(shareId: string): Promise<StoredProviderShare | null>;
  findActiveShare(hostDeviceId: string, providerId: string): Promise<StoredProviderShare | null>;
  /** Upserts only the share row (profile and status); member rows are untouched. */
  saveShareProfile(share: StoredProviderShare): Promise<void>;
  /** Upserts exactly one member row of a share owned by the transaction owner. */
  saveMember(share: StoredProviderShare, member: StoredProviderShareMember): Promise<void>;
  getLink(digest: string): Promise<StoredProviderShareLink | null>;
  insertLink(link: StoredProviderShareLink): Promise<void>;
  /** `requested → consumed | rejected | withdrawn`; never touches a link in any other state. */
  closeLink(digest: string, state: 'consumed' | 'rejected' | 'withdrawn'): Promise<void>;
  /** Atomic `unused → requested` for a still-valid link; false when another request won. */
  claimLink(digest: string, now: number): Promise<boolean>;
  getRequest(requestId: string): Promise<StoredProviderShareRequest | null>;
  getRequestByLink(digest: string): Promise<StoredProviderShareRequest | null>;
  /** The unique linkDigest constraint rejects a second request for one link. */
  insertRequest(request: StoredProviderShareRequest): Promise<void>;
  /**
   * Conditional `pending → decision` for a request that is still pending and unexpired at
   * `now`, evaluated by the database on the latest row version. False when a concurrent
   * writer (notably the unlocked expiry sweep) changed the request first.
   */
  decidePendingRequest(requestId: string, now: number, decision: { status: 'approved' | 'rejected' | 'withdrawn'; memberId?: string }): Promise<boolean>;
  /** Same condition as decidePendingRequest; replaces the requestToken digest only. */
  rotatePendingRequestToken(requestId: string, now: number, requestTokenDigest: string): Promise<boolean>;
}
export interface OwnerShareView { share: StoredProviderShare; requests: StoredProviderShareRequest[] }
export interface ProviderShareRepository {
  findShare(shareId: string): Promise<StoredProviderShare | null>;
  findLink(digest: string): Promise<Owned<StoredProviderShareLink> | null>;
  findRequest(requestId: string): Promise<Owned<StoredProviderShareRequest> | null>;
  findMember(memberId: string): Promise<{ shareId: string; ownerAccountId: string } | null>;
  /** Active shares of one owner device with their pending requests. */
  listOwnerShares(ownerAccountId: string, hostDeviceId: string): Promise<OwnerShareView[]>;
  /** Active shares where guestKey is an active or paused member. */
  listReceived(guestKey: string): Promise<StoredProviderShare[]>;
  /**
   * Serializes every mutation for an owner across relay instances. The optional
   * guest lock is always taken after the owner lock (fixed order, no cycles).
   */
  transaction<T>(ownerAccountId: string, work: (tx: ProviderShareTransaction) => Promise<T>, guestKey?: string): Promise<T>;
  /** Marks pending requests and unused links whose deadline passed; returns counts. */
  expire(now: number): Promise<{ links: number; requests: number }>;
  /** Deletes links, terminal requests and guest credentials whose lifetime ended before `before`. */
  purge(before: number): Promise<{ links: number; requests: number }>;
  /** Whether guestKey has an active member in an active share (cross-region connection gate). */
  hasActiveMember(guestKey: string): Promise<boolean>;
  /** Upsert per (guestKey, deviceId): issuing again replaces the digest, invalidating the old credential. */
  saveGuestCredential(credential: StoredGuestCredential): Promise<void>;
  findGuestCredential(digest: string): Promise<StoredGuestCredential | null>;
}

export interface ProviderShareHostStatus { online: boolean; capabilities: readonly string[] }
export interface ProviderShareCrossRegionOptions {
  peerRegion: ProviderShareRegion;
  /** Peer-issuer verifier; it also pins the card region to peerRegion. */
  identityCards: IdentityCardVerifier;
}
/** Verified cross-region guest; produced only by identifying a peer identity card. */
export interface CrossRegionGuest { guestKey: string; guest: PersonSnapshot }
export interface GuestConnectionIdentity { guestKey: string; deviceId: string; digest: string }
export interface AuthenticatedGuestCredential extends GuestConnectionIdentity { expiresAt: number }
export interface ProviderShareServiceOptions {
  identityCards: IdentityCardVerifier;
  /** null/undefined keeps every cross-region entry point disabled. */
  crossRegion?: ProviderShareCrossRegionOptions | null;
  /** Called after a cross-region guest's membership or credential changed (relay revalidates). */
  onGuestChanged?: (guestKey: string) => void;
  /** Relay presence of the owner device; used only for the guest's received list. */
  hostStatus(accountId: string, deviceId: string): Promise<ProviderShareHostStatus>;
  hostCapability: string;
  now?: () => number;
}

const INVITATION = /^[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalidParams('Invalid identifier');
  return value;
};
/** Provider IDs are opaque client keys; nonce binding uses them byte-for-byte. */
const providerId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || CONTROL.test(value)) throw invalidParams('Invalid providerId');
  return value;
};
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || CONTROL.test(value)) throw invalidParams('Invalid label');
  return value.trim();
};
const card = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) throw invalidParams('Invalid identityCard');
  return value;
};
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Guest-local device ids follow auth-server's 1..128 device claim contract. */
const localDeviceId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw invalidParams('Invalid deviceId');
  return value;
};
const shortLabel = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) throw invalidParams('Invalid label');
  return value.trim();
};
function validateActor(actor: ProviderShareActor): void {
  id(actor.accountId);
  // Device claims follow auth-server's 1..128 string contract, not internal IDs.
  if (typeof actor.deviceId !== 'string' || actor.deviceId.length < 1 || actor.deviceId.length > 128) {
    throw invalidParams('Invalid device identifier');
  }
}
export const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');
/** Nonce bound into a share-link identity card. */
export const shareLinkNonce = (hostDeviceId: string, provider: string) => sha256hex(`${hostDeviceId}:${provider}`);
/** P1 same-region guest key; P3 adds `x:<region>:<sub>` without changing storage. */
const guestKeyOf = (actor: ProviderShareActor) => actor.accountId;
const iso = (ms: number) => new Date(ms).toISOString();
/** Cross-region guest key: never collides with a membershipId (cuid). */
export const crossRegionGuestKey = (region: ProviderShareRegion, subject: string) => `x:${region}:${subject}`;
/** Cross-region device id: hashed so it never collides with a real device id of this region. */
export const crossRegionDeviceId = (region: ProviderShareRegion, deviceId: string) => `x:${region}:${sha256hex(deviceId).slice(0, 32)}`;
const isCrossRegionKey = (guestKey: string) => guestKey.startsWith('x:');
const sameDigest = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const person = (value: PersonSnapshot) => ({ displayName: value.displayName, avatarUrl: value.avatarUrl, region: value.region });

export const linkUsed = () => new AppError('PROVIDER_SHARE_LINK_USED', 409, 'Provider share link already used');
const linkExpired = () => new AppError('PROVIDER_SHARE_LINK_EXPIRED', 410, 'Provider share link or request expired');
const selfShare = () => new AppError('PROVIDER_SHARE_SELF', 409, 'This provider belongs to your own account');
const alreadyMember = () => new AppError('PROVIDER_SHARE_ALREADY_MEMBER', 409, 'Already a member of this provider share');
const notHostDevice = () => new AppError('PROVIDER_SHARE_NOT_HOST_DEVICE', 403, 'Manage this share from the device that hosts the provider');
export const crossRegionDisabled = () => new AppError('PROVIDER_SHARE_CROSS_REGION_DISABLED', 403, 'Cross-region provider sharing is disabled');

/** Pending requests past their deadline behave as expired before the sweep persists it. */
function effectiveRequestStatus(request: StoredProviderShareRequest, now: number): ProviderShareRequestStatus {
  return request.status === 'pending' && request.expiresAt <= now ? 'expired' : request.status;
}

/**
 * Provider-share lifecycle. The server is the membership authority; the host device
 * remains the authority for usage scope and enforces it on every run. Link tokens are
 * returned once and only their digest is stored. Person snapshots come exclusively
 * from verified identity cards, never from request fields.
 */
export function createProviderShareService(repo: ProviderShareRepository, options: ProviderShareServiceOptions) {
  const now = options.now ?? Date.now;

  function ownedBy(actor: ProviderShareActor, share: StoredProviderShare | null): StoredProviderShare {
    // Shares, requests and members of another account are indistinguishable from absent ones.
    if (!share || share.status !== 'active' || share.ownerAccountId !== actor.accountId) throw notFound();
    if (share.hostDeviceId !== actor.deviceId) throw notHostDevice();
    return share;
  }
  async function verify(cardValue: string, purpose: IdentityCardPurpose, nonce: string, actor: ProviderShareActor) {
    return options.identityCards.verify(cardValue, { purpose, nonce, subject: actor.accountId });
  }
  function bump(member: StoredProviderShareMember, status: ProviderShareMemberStatus): void {
    member.status = status;
    member.version++;
  }
  /**
   * Per-frame relay check: this exact credential is still the current, unexpired one for
   * (guestKey, device). A rotated credential fails immediately, before its socket closes.
   */
  async function credentialCurrent(connection: GuestConnectionIdentity): Promise<boolean> {
    if (!options.crossRegion || !connection.guestKey.startsWith(`x:${options.crossRegion.peerRegion}:`)) return false;
    const stored = await repo.findGuestCredential(connection.digest);
    return !!stored && stored.guestKey === connection.guestKey && stored.deviceId === connection.deviceId && stored.expiresAt > now();
  }
  /** A conditional request write lost: report what the request became. */
  async function lostRace(tx: ProviderShareTransaction, requestId: string, at: number): Promise<never> {
    const current = await tx.getRequest(requestId);
    if (current && effectiveRequestStatus(current, at) === 'expired') throw linkExpired();
    throw conflict('Provider share request already decided');
  }
  /** Shared by owner decisions and guest withdrawal; runs inside the owner lock. */
  async function decide(
    tx: ProviderShareTransaction, requestId: string, share: StoredProviderShare,
    terminal: 'rejected' | 'withdrawn',
  ): Promise<void> {
    const request = await tx.getRequest(requestId);
    if (!request || request.shareId !== share.shareId) throw notFound();
    if (request.status === terminal) return;
    const at = now();
    const status = effectiveRequestStatus(request, at);
    if (status === 'expired') throw linkExpired();
    if (status !== 'pending') throw conflict('Provider share request already decided');
    if (!(await tx.decidePendingRequest(requestId, at, { status: terminal }))) await lostRace(tx, requestId, at);
    await tx.closeLink(request.linkDigest, terminal);
  }
  function changed(guestKey: string): void {
    if (isCrossRegionKey(guestKey)) options.onGuestChanged?.(guestKey);
  }
  function crossRegion(): ProviderShareCrossRegionOptions {
    if (!options.crossRegion) throw crossRegionDisabled();
    return options.crossRegion;
  }
  async function identify(cardValue: unknown, purpose: IdentityCardPurpose, nonce: string): Promise<CrossRegionGuest> {
    const peer = crossRegion();
    const verified = await peer.identityCards.inspect(card(cardValue), { purpose, nonce });
    return { guestKey: id(crossRegionGuestKey(peer.peerRegion, verified.subject)), guest: verified.person };
  }
  const activeOrPaused = (member: StoredProviderShareMember, guestKey: string) =>
    member.guestKey === guestKey && (member.status === 'active' || member.status === 'paused');

  async function previewFor(guestKey: string, invitation: unknown) {
    if (typeof invitation !== 'string' || !INVITATION.test(invitation)) throw notFound();
    const link = await repo.findLink(sha256hex(invitation));
    if (!link) throw notFound();
    const share = await repo.findShare(link.shareId);
    if (!share || share.status !== 'active') throw notFound();
    if (share.ownerAccountId === guestKey) throw selfShare();
    if (share.members.some((member) => activeOrPaused(member, guestKey))) throw alreadyMember();
    const at = now();
    const state = link.state === 'unused' ? (link.expiresAt > at ? 'unused' : 'expired') : link.state === 'expired' ? 'expired' : 'used';
    return {
      shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel,
      deviceName: share.deviceName, owner: person(share.owner), state, expiresAt: iso(link.expiresAt),
    };
  }

  /** Locks the link for the first request. Cross-region requests also get a requestToken. */
  async function createRequestFor(
    located: Owned<StoredProviderShareLink>, guestKey: string, guest: PersonSnapshot, withToken: boolean,
  ) {
    const digest = located.digest;
    return repo.transaction(located.ownerAccountId, async (tx) => {
      const share = await tx.getShare(located.shareId);
      if (!share || share.status !== 'active') throw notFound();
      if (share.ownerAccountId === guestKey) throw selfShare();
      const link = await tx.getLink(digest);
      if (!link) throw notFound();
      const at = now();
      const requestToken = withToken ? randomBytes(32).toString('base64url') : undefined;
      const respond = (request: StoredProviderShareRequest) => ({
        requestId: request.requestId, pairingCode: request.pairingCode, status: 'pending' as const, expiresAt: iso(request.expiresAt),
        ...(requestToken ? { requestToken } : {}),
      });
      // A retried submission by the same guest returns its own pending request. Only the
      // digest of a requestToken is stored, so a cross-region retry rotates the token.
      if (link.state === 'requested') {
        const existing = await tx.getRequestByLink(digest);
        if (existing && existing.guestKey === guestKey && effectiveRequestStatus(existing, at) === 'pending') {
          if (requestToken && !(await tx.rotatePendingRequestToken(existing.requestId, at, sha256hex(requestToken)))) {
            await lostRace(tx, existing.requestId, at);
          }
          return respond(existing);
        }
      }
      if (share.members.some((member) => activeOrPaused(member, guestKey))) throw alreadyMember();
      if (link.state === 'expired' || (link.state === 'unused' && link.expiresAt <= at)) throw linkExpired();
      if (link.state !== 'unused' || !(await tx.claimLink(digest, at))) throw linkUsed();
      const request: StoredProviderShareRequest = {
        requestId: randomUUID(), linkDigest: digest, shareId: share.shareId, guestKey, guest,
        pairingCode: String(randomInt(0, 10_000)).padStart(4, '0'), status: 'pending',
        requestTokenDigest: requestToken ? sha256hex(requestToken) : null, memberId: null,
        createdAt: at, expiresAt: at + PROVIDER_SHARE_REQUEST_TTL_MS, decidedAt: null,
      };
      await tx.insertRequest(request);
      return respond(request);
    }, guestKey);
  }

  async function getRequestFor(guestKey: string, requestId: string) {
    id(requestId);
    const request = await repo.findRequest(requestId);
    // Only the applicant can read a request; the owner sees it through GET /.
    if (!request || request.guestKey !== guestKey) throw notFound();
    const status = effectiveRequestStatus(request, now());
    return {
      requestId: request.requestId, status, pairingCode: request.pairingCode, expiresAt: iso(request.expiresAt),
      ...(status === 'approved' && request.memberId ? { shareId: request.shareId, memberId: request.memberId } : {}),
    };
  }

  async function withdrawFor(guestKey: string, requestId: string) {
    id(requestId);
    const located = await repo.findRequest(requestId);
    if (!located || located.guestKey !== guestKey) throw notFound();
    return repo.transaction(located.ownerAccountId, async (tx) => {
      const share = await tx.getShare(located.shareId);
      if (!share) throw notFound();
      const request = await tx.getRequest(requestId);
      if (!request || request.guestKey !== guestKey) throw notFound();
      await decide(tx, requestId, share, 'withdrawn');
      return { requestId, status: 'withdrawn' as const };
    }, guestKey);
  }

  async function listReceivedFor(guestKey: string) {
    const shares = (await repo.listReceived(guestKey)).filter((share) => share.status === 'active');
    return Promise.all(shares.flatMap((share) => {
      const member = share.members.find((item) => activeOrPaused(item, guestKey));
      if (!member) return [];
      return [(async () => {
        const host = await options.hostStatus(share.ownerAccountId, share.hostDeviceId);
        return {
          shareId: share.shareId, memberId: member.memberId, providerId: share.providerId, providerLabel: share.providerLabel,
          hostDeviceId: share.hostDeviceId, deviceName: share.deviceName, owner: person(share.owner),
          status: member.status as 'active' | 'paused',
          hostOnline: host.online,
          hostCapable: host.online && host.capabilities.includes(options.hostCapability),
        };
      })()];
    }));
  }

  return {
    async listOwner(actor: ProviderShareActor) {
      validateActor(actor);
      const at = now();
      return (await repo.listOwnerShares(actor.accountId, actor.deviceId))
        .filter(({ share }) => share.status === 'active' && share.ownerAccountId === actor.accountId && share.hostDeviceId === actor.deviceId)
        .map(({ share, requests }) => ({
          shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel,
          hostDeviceId: share.hostDeviceId, createdAt: iso(share.createdAt),
          members: share.members.filter((member) => member.status === 'active' || member.status === 'paused').map((member) => ({
            ...person(member.guest), memberId: member.memberId, status: member.status as 'active' | 'paused', joinedAt: iso(member.joinedAt),
          })),
          requests: requests.filter((request) => effectiveRequestStatus(request, at) === 'pending').map((request) => ({
            ...person(request.guest), requestId: request.requestId, pairingCode: request.pairingCode,
            linkId: request.linkDigest,
            createdAt: iso(request.createdAt), expiresAt: iso(request.expiresAt),
          })),
        }));
    },

    async createLink(actor: ProviderShareActor, input: { providerId: unknown; providerLabel: unknown; deviceName: unknown; identityCard: unknown }) {
      validateActor(actor);
      const provider = providerId(input.providerId);
      const providerLabel = label(input.providerLabel);
      const deviceName = label(input.deviceName);
      const owner = await verify(card(input.identityCard), 'share-link', shareLinkNonce(actor.deviceId, provider), actor);
      return repo.transaction(actor.accountId, async (tx) => {
        const at = now();
        // One active share per (owner, device, provider); each link refreshes its snapshot.
        const share: StoredProviderShare = (await tx.findActiveShare(actor.deviceId, provider)) ?? {
          shareId: randomUUID(), ownerAccountId: actor.accountId, hostDeviceId: actor.deviceId, providerId: provider,
          providerLabel, deviceName, owner, status: 'active', createdAt: at, members: [],
        };
        Object.assign(share, { providerLabel, deviceName, owner });
        await tx.saveShareProfile(share);
        const invitation = randomBytes(32).toString('base64url');
        const linkId = sha256hex(invitation);
        const expiresAt = at + PROVIDER_SHARE_LINK_TTL_MS;
        await tx.insertLink({ digest: linkId, shareId: share.shareId, state: 'unused', createdAt: at, expiresAt });
        return { shareId: share.shareId, invitation, linkId, expiresAt: iso(expiresAt) };
      });
    },

    async approve(actor: ProviderShareActor, requestId: string) {
      validateActor(actor); id(requestId);
      const located = await repo.findRequest(requestId);
      if (!located || located.ownerAccountId !== actor.accountId) throw notFound();
      return repo.transaction(located.ownerAccountId, async (tx) => {
        const share = ownedBy(actor, await tx.getShare(located.shareId));
        const request = await tx.getRequest(requestId);
        if (!request || request.shareId !== share.shareId) throw notFound();
        // Retried approvals return the same membership.
        if (request.status === 'approved' && request.memberId) return { shareId: share.shareId, memberId: request.memberId };
        const at = now();
        const status = effectiveRequestStatus(request, at);
        if (status === 'expired') throw linkExpired();
        if (status !== 'pending') throw conflict('Provider share request already decided');
        let member = share.members.find((item) => item.guestKey === request.guestKey);
        if (member) {
          // Idempotent per (share, guestKey): restore a tombstone, keep its memberId.
          // The version bump invalidates any in-flight relay grant of the old admission.
          if (member.status !== 'active') {
            const departed = member.status === 'removed' || member.status === 'left';
            bump(member, 'active');
            // Approval epoch: a tombstone rejoin is always a new admission,
            // including same-millisecond approvals and wall-clock rollback.
            if (departed) member.joinedAt = Math.max(at, member.joinedAt + 1);
          }
          member.guest = request.guest;
        } else {
          member = { memberId: randomUUID(), guestKey: request.guestKey, guest: request.guest, status: 'active', version: 1, deviceIds: [], joinedAt: at };
        }
        // Decide the request first, conditionally: if the expiry sweep (or anything else)
        // got there first, the transaction rolls back before any membership is written.
        // The cross-region requestToken stays valid so the guest can read the approval.
        if (!(await tx.decidePendingRequest(requestId, at, { status: 'approved', memberId: member.memberId }))) {
          await lostRace(tx, requestId, at);
        }
        await tx.saveMember(share, member);
        await tx.closeLink(request.linkDigest, 'consumed');
        return { shareId: share.shareId, memberId: member.memberId };
      }, located.guestKey);
    },

    async reject(actor: ProviderShareActor, requestId: string) {
      validateActor(actor); id(requestId);
      const located = await repo.findRequest(requestId);
      if (!located || located.ownerAccountId !== actor.accountId) throw notFound();
      return repo.transaction(located.ownerAccountId, async (tx) => {
        const share = ownedBy(actor, await tx.getShare(located.shareId));
        await decide(tx, requestId, share, 'rejected');
        return { requestId, status: 'rejected' as const };
      });
    },

    async setMemberStatus(actor: ProviderShareActor, memberId: string, action: 'pause' | 'resume' | 'remove') {
      validateActor(actor); id(memberId);
      const located = await repo.findMember(memberId);
      if (!located || located.ownerAccountId !== actor.accountId) throw notFound();
      const result = await repo.transaction(located.ownerAccountId, async (tx) => {
        const share = ownedBy(actor, await tx.getShare(located.shareId));
        const member = share.members.find((item) => item.memberId === memberId);
        if (!member || member.status === 'left') throw notFound();
        const target: ProviderShareMemberStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'removed';
        if (member.status === 'removed' && target !== 'removed') throw notFound();
        const updated = member.status !== target;
        if (updated) {
          // Device bindings survive pause and removal so the host can still deliver
          // link-close / invoke-result tear-down frames; the status gates admission.
          bump(member, target);
          await tx.saveMember(share, member);
        }
        return { memberId, status: member.status as 'active' | 'paused' | 'removed', guestKey: member.guestKey, updated };
      });
      // After commit: cross-region guest connections are revalidated (and closed when no
      // member stays active). Same-region guests use their account connection.
      if (result.updated) changed(result.guestKey);
      return { memberId: result.memberId, status: result.status };
    },

    async preview(actor: ProviderShareActor, invitation: unknown) {
      validateActor(actor);
      return previewFor(guestKeyOf(actor), invitation);
    },

    async createRequest(actor: ProviderShareActor, invitation: unknown, identityCard: unknown) {
      validateActor(actor);
      if (typeof invitation !== 'string' || !INVITATION.test(invitation)) throw notFound();
      const cardValue = card(identityCard);
      const digest = sha256hex(invitation);
      const located = await repo.findLink(digest);
      if (!located) throw notFound();
      if (located.ownerAccountId === actor.accountId) throw selfShare();
      const guest = await verify(cardValue, 'share-request', sha256hex(invitation), actor);
      return createRequestFor(located, guestKeyOf(actor), guest, false);
    },

    async getRequest(actor: ProviderShareActor, requestId: string) {
      validateActor(actor);
      return getRequestFor(guestKeyOf(actor), requestId);
    },

    async withdraw(actor: ProviderShareActor, requestId: string) {
      validateActor(actor);
      return withdrawFor(guestKeyOf(actor), requestId);
    },

    async listReceived(actor: ProviderShareActor) {
      validateActor(actor);
      return listReceivedFor(guestKeyOf(actor));
    },

    async leave(actor: ProviderShareActor, memberId: string) {
      validateActor(actor); id(memberId);
      const located = await repo.findMember(memberId);
      if (!located) throw notFound();
      const guestKey = guestKeyOf(actor);
      const result = await repo.transaction(located.ownerAccountId, async (tx) => {
        const share = await tx.getShare(located.shareId);
        const member = share?.members.find((item) => item.memberId === memberId && item.guestKey === guestKey);
        if (!share || !member || member.status === 'removed') throw notFound();
        if (member.status !== 'left') {
          bump(member, 'left');
          await tx.saveMember(share, member);
        }
        return { memberId, status: 'left' as const };
      }, guestKey);
      changed(guestKey);
      return result;
    },

    /** First-hop relay link-open only: enroll another device of the same guest account.
     * Never revives a paused, removed or departed member. */
    async connectDevice(actor: ProviderShareActor, shareId: string, memberId: string, hostDeviceId: string) {
      validateActor(actor);
      const located = await repo.findShare(id(shareId));
      if (!located) return null;
      return repo.transaction(located.ownerAccountId, async (tx) => {
        const share = await tx.getShare(shareId);
        if (!share || share.status !== 'active' || share.hostDeviceId !== hostDeviceId) return null;
        const member = share.members.find((item) => item.memberId === memberId && item.guestKey === guestKeyOf(actor) && item.status === 'active');
        if (!member) return null;
        if (!member.deviceIds.includes(actor.deviceId)) {
          if (member.deviceIds.length >= PROVIDER_SHARE_MAX_MEMBER_DEVICES) return null;
          member.deviceIds.push(actor.deviceId);
          member.version++;
          await tx.saveMember(share, member);
        }
        return share;
      });
    },

    // ── Cross-region (P3, contract §6). Every entry point is disabled unless configured. ──

    get crossRegionEnabled() { return !!options.crossRegion; },

    /** Peer card for preview/requests: purpose share-request, nonce sha256hex(invitation). */
    async xIdentifyForInvitation(identityCard: unknown, invitation: unknown): Promise<CrossRegionGuest> {
      crossRegion();
      if (typeof invitation !== 'string' || !INVITATION.test(invitation)) throw notFound();
      return identify(identityCard, 'share-request', sha256hex(invitation));
    },
    /** Peer card for sessions: purpose share-session, nonce sha256hex(guest-local deviceId). */
    async xIdentifyForSession(identityCard: unknown, deviceId: unknown): Promise<CrossRegionGuest> {
      crossRegion();
      return identify(identityCard, 'share-session', sha256hex(localDeviceId(deviceId)));
    },
    async xPreview(guest: CrossRegionGuest, invitation: unknown) {
      crossRegion();
      return previewFor(guest.guestKey, invitation);
    },
    async xCreateRequest(guest: CrossRegionGuest, invitation: unknown) {
      crossRegion();
      if (typeof invitation !== 'string' || !INVITATION.test(invitation)) throw notFound();
      const located = await repo.findLink(sha256hex(invitation));
      if (!located) throw notFound();
      return createRequestFor(located, guest.guestKey, guest.guest, true) as Promise<Awaited<ReturnType<typeof createRequestFor>> & { requestToken: string }>;
    },
    /** requestToken authenticates exactly one request; returns its guestKey (for rate limiting). */
    async xAuthorizeRequest(requestId: unknown, requestToken: unknown): Promise<string> {
      crossRegion();
      if (typeof requestToken !== 'string' || !TOKEN.test(requestToken)) throw notFound();
      const request = await repo.findRequest(id(requestId));
      if (!request?.requestTokenDigest || !sameDigest(request.requestTokenDigest, sha256hex(requestToken))) throw notFound();
      return request.guestKey;
    },
    async xGetRequest(guestKey: string, requestId: string) {
      crossRegion();
      return getRequestFor(guestKey, requestId);
    },
    async xWithdraw(guestKey: string, requestId: string) {
      crossRegion();
      return withdrawFor(guestKey, requestId);
    },
    /**
     * Registers the guest's cross-region device for every active or paused member (64-device
     * cap per member) and rotates its connection credential. No membership → no credential.
     */
    async xOpenSession(guest: CrossRegionGuest, input: { deviceId: unknown; deviceName: unknown; platform: unknown }) {
      const peer = crossRegion();
      const local = localDeviceId(input.deviceId);
      // deviceName/platform are validated for the contract but not persisted (data minimization).
      shortLabel(input.deviceName, 128); shortLabel(input.platform, 64);
      const deviceId = crossRegionDeviceId(peer.peerRegion, local);
      const { guestKey } = guest;
      for (const share of await repo.listReceived(guestKey)) {
        await repo.transaction(share.ownerAccountId, async (tx) => {
          const current = await tx.getShare(share.shareId);
          const member = current?.status === 'active' ? current.members.find((item) => activeOrPaused(item, guestKey)) : undefined;
          if (!current || !member || member.deviceIds.includes(deviceId) || member.deviceIds.length >= PROVIDER_SHARE_MAX_MEMBER_DEVICES) return;
          member.deviceIds.push(deviceId);
          member.version++;
          await tx.saveMember(current, member);
        }, guestKey);
      }
      const shares = await listReceivedFor(guestKey);
      if (shares.length === 0) return { credential: null, expiresAt: null, deviceId, shares };
      const credential = randomBytes(32).toString('base64url');
      const at = now();
      const expiresAt = at + PROVIDER_SHARE_GUEST_CREDENTIAL_TTL_MS;
      await repo.saveGuestCredential({ guestKey, deviceId, digest: sha256hex(credential), createdAt: at, expiresAt });
      // A rotated credential must stop working immediately on every relay instance.
      changed(guestKey);
      return { credential, expiresAt: iso(expiresAt), deviceId, shares };
    },
    /** `ProviderShareGuest <credential>`: valid, unexpired, current credential of this peer region. */
    async authenticateGuestCredential(credential: unknown): Promise<AuthenticatedGuestCredential | null> {
      const peer = options.crossRegion;
      if (!peer || typeof credential !== 'string' || !TOKEN.test(credential)) return null;
      const stored = await repo.findGuestCredential(sha256hex(credential));
      if (!stored || stored.expiresAt <= now() || !stored.guestKey.startsWith(`x:${peer.peerRegion}:`)) return null;
      return { guestKey: stored.guestKey, deviceId: stored.deviceId, digest: stored.digest, expiresAt: stored.expiresAt };
    },
    /**
     * Per-frame relay check: this exact credential is still the current, unexpired one for
     * (guestKey, device). A rotated credential fails immediately, before its socket closes.
     */
    isGuestCredentialCurrent: credentialCurrent,
    /** Connection gate: the credential is current and at least one member stays active. */
    async isGuestConnectionValid(connection: GuestConnectionIdentity): Promise<boolean> {
      if (!(await credentialCurrent(connection))) return false;
      return repo.hasActiveMember(connection.guestKey);
    },
  };
}

export type ProviderShareService = ReturnType<typeof createProviderShareService>;
