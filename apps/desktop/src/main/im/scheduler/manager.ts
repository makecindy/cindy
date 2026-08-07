/** Dormant, provider-free coordinator. Discord Gateway wiring belongs to PR-B. */

import { randomUUID } from 'node:crypto';

import {
  isImSchedulerFrame,
  type ImSchedulerFrame,
  type SchedulerAdvertisementFrame,
} from '@cindy/device-link';
import { RuntimeGapSet } from './runtimeGaps';
import {
  isDesktopSchedulerPlatform,
  selectIngressDevice,
  type SchedulerChannelIdentity,
  type SchedulerDevice,
} from './state';
import type { SchedulerDesktopDeviceSnapshot } from './deviceSnapshot';
import type { SchedulerTransport, SchedulerTransportEvent } from './transport';

const DEFAULT_DISCOVERY_RETRY_DELAY_MS = 1_000;
const DEFAULT_DISCOVERY_RETRY_LIMIT = 3;
const DEFAULT_SNAPSHOT_RESPONSE_TIMEOUT_MS = 5_000;

export type SchedulerDecision =
  | { state: 'active'; channel: SchedulerChannelIdentity; reason: 'elected' }
  | { state: 'standby'; channel: SchedulerChannelIdentity | null; reason: SchedulerStandbyReason };

export type SchedulerStandbyReason =
  | 'stopped'
  | 'relay-offline'
  | 'not-owner'
  | 'missing-binding'
  | 'missing-snapshot'
  | 'incomplete-peer-view'
  | 'peer-won';

interface PeerAdvertisement {
  sentAt: number;
  frame: SchedulerAdvertisementFrame;
}

export interface ImSchedulerManagerOptions {
  transport: SchedulerTransport;
  getLocalChannel: () => SchedulerChannelIdentity | null;
  onDecision?: (decision: SchedulerDecision) => void;
  nonceFactory?: () => string;
  discoveryRetryDelayMs?: number;
  snapshotResponseTimeoutMs?: number;
  maxDiscoveryRetries?: number;
}

/**
 * The manager owns only election state. It never starts, stops, or inspects a
 * provider client, so creating this object cannot change existing IM behavior.
 */
export class ImSchedulerManager {
  private readonly transport: SchedulerTransport;
  private readonly getLocalChannel: () => SchedulerChannelIdentity | null;
  private readonly onDecision?: (decision: SchedulerDecision) => void;
  private readonly nonceFactory: () => string;
  private readonly discoveryRetryDelayMs: number;
  private readonly snapshotResponseTimeoutMs: number;
  private readonly maxDiscoveryRetries: number;
  private readonly peers = new Map<string, PeerAdvertisement>();
  private readonly confirmedPeers = new Set<string>();
  private readonly runtimeGaps = new RuntimeGapSet();
  private unsubscribe: (() => void) | null = null;
  private snapshot: SchedulerDesktopDeviceSnapshot | null = null;
  private lastSnapshotObservedAt: number | null = null;
  private snapshotAccountGeneration = '';
  private snapshotRequestId: string | null = null;
  private awaitingSnapshot = false;
  private requiresTaggedSnapshot = false;
  private snapshotRefreshPending = false;
  private lastLocalIdentity: string | null = null;
  private discoveryNonce = '';
  private discoveryRetryAttempt = 0;
  private discoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private decision: SchedulerDecision = { state: 'standby', channel: null, reason: 'stopped' };

  constructor(options: ImSchedulerManagerOptions) {
    this.transport = options.transport;
    this.getLocalChannel = options.getLocalChannel;
    this.onDecision = options.onDecision;
    this.nonceFactory = options.nonceFactory ?? (() => randomUUID().replaceAll('-', ''));
    this.discoveryRetryDelayMs = Math.max(
      1,
      Math.floor(options.discoveryRetryDelayMs ?? DEFAULT_DISCOVERY_RETRY_DELAY_MS),
    );
    this.snapshotResponseTimeoutMs = Math.max(
      1,
      Math.floor(options.snapshotResponseTimeoutMs ?? DEFAULT_SNAPSHOT_RESPONSE_TIMEOUT_MS),
    );
    this.maxDiscoveryRetries = Math.max(
      1,
      Math.floor(options.maxDiscoveryRetries ?? DEFAULT_DISCOVERY_RETRY_LIMIT),
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.resetSnapshotRequestState();
    this.requiresTaggedSnapshot = false;
    this.snapshotAccountGeneration = this.nonceFactory();
    this.lastLocalIdentity = this.getLocalChannel()?.identity ?? null;
    this.unsubscribe = this.transport.subscribe((event) => this.handleEvent(event));
    this.beginDiscoveryRound();
    this.reconcile();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.cancelDiscoveryRetry();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.runtimeGaps.clear();
    this.snapshot = null;
    this.lastSnapshotObservedAt = null;
    this.resetSnapshotRequestState();
    this.requiresTaggedSnapshot = false;
    this.snapshotAccountGeneration = '';
    this.lastLocalIdentity = null;
    this.publishDecision({ state: 'standby', channel: null, reason: 'stopped' });
  }

  /** Start a new round after a binding change while retaining the account view. */
  resetBindingDiscovery(): void {
    this.resetDiscovery('binding');
  }

  /** Start a new account-scoped round and discard the previous account state. */
  resetAccountDiscovery(): void {
    this.resetDiscovery('account');
  }

  resetDiscovery(scope: 'binding' | 'account' = 'binding'): void {
    if (!this.started) return;
    this.cancelDiscoveryRetry();
    if (scope === 'account') {
      this.snapshot = null;
      this.lastSnapshotObservedAt = null;
      this.snapshotAccountGeneration = this.nonceFactory();
      this.resetSnapshotRequestState();
      this.requiresTaggedSnapshot = true;
      this.lastLocalIdentity = this.getLocalChannel()?.identity ?? null;
      this.runtimeGaps.clear();
    } else {
      const currentIdentity = this.getLocalChannel()?.identity ?? null;
      for (const identity of [this.lastLocalIdentity, currentIdentity]) {
        if (identity) this.runtimeGaps.clearIdentity(identity);
      }
      this.lastLocalIdentity = currentIdentity;
    }
    this.beginDiscoveryRound();
    if (scope === 'account') this.requestSnapshot(false);
    this.reconcile();
  }

  getDecision(): SchedulerDecision {
    return this.decision;
  }

  getRuntimeGaps(): RuntimeGapSet {
    return this.runtimeGaps;
  }

  private handleEvent(event: SchedulerTransportEvent): void {
    if (!this.started) return;
    switch (event.type) {
      case 'relay-status':
        if (event.status === 'offline') {
          this.cancelDiscoveryRetry();
          this.snapshot = null;
          this.lastSnapshotObservedAt = null;
          this.resetSnapshotRequestState();
          this.requiresTaggedSnapshot = true;
          this.peers.clear();
          this.confirmedPeers.clear();
        } else {
          this.beginDiscoveryRound();
        }
        this.reconcile();
        return;
      case 'ownership':
        if (event.owner) {
          // Ownership may have been absent long enough for the Device Link
          // membership view to change. Never elect from a snapshot collected
          // before that gap; require a tagged refresh for the current request
          // generation before discovery can complete again.
          this.invalidateAuthoritativeSnapshot();
          this.beginDiscoveryRound();
          this.requestSnapshot(false);
        } else {
          this.cancelDiscoveryRetry();
        }
        this.reconcile();
        return;
      case 'snapshot': {
        if (
          this.requiresTaggedSnapshot &&
          (event.accountGeneration === undefined || event.requestId === undefined)
        ) {
          return;
        }
        if (
          event.accountGeneration !== undefined &&
          event.accountGeneration !== this.snapshotAccountGeneration
        ) {
          return;
        }
        const pendingRequestId = this.snapshotRequestId;
        if (event.requestId !== undefined && event.requestId !== pendingRequestId) return;
        if (this.awaitingSnapshot && event.requestId === undefined) return;
        const isCurrentRequest =
          event.requestId !== undefined && event.requestId === pendingRequestId;
        const preserveRetryAttempt = this.snapshotRefreshPending;
        this.resetSnapshotRequestState();
        if (event.snapshot === null) {
          // A null authoritative snapshot means the transport can no longer
          // prove that this Desktop is present. Retaining the previous view
          // would allow a stale self row to keep the ingress active.
          this.snapshot = null;
          this.lastSnapshotObservedAt = null;
          this.requiresTaggedSnapshot = true;
          this.peers.clear();
          this.confirmedPeers.clear();
          this.beginDiscoveryRound({ resetRetryAttempt: !preserveRetryAttempt });
          this.reconcile();
          return;
        }
        if (
          !isCurrentRequest &&
          this.lastSnapshotObservedAt !== null &&
          event.snapshot.observedAt < this.lastSnapshotObservedAt
        ) {
          // A clock rollback or delayed response must not revive an older
          // account view after a newer snapshot has already been accepted.
          this.reconcile();
          return;
        }
        this.snapshot = event.snapshot;
        this.lastSnapshotObservedAt = event.snapshot.observedAt;
        // Once a lifecycle freshness boundary has been crossed, keep the
        // tagged-response gate latched for the rest of this manager lifetime.
        // An older untagged request may still complete after this response.
        this.beginDiscoveryRound({ resetRetryAttempt: !preserveRetryAttempt });
        this.reconcile();
        return;
      }
      case 'peer-presence':
        if (!isDesktopSchedulerPlatform(event.platform)) return;
        // Incremental presence is a signal to fetch a new full snapshot, not
        // an authoritative replacement for the existing membership view.
        this.cancelDiscoveryRetry();
        this.snapshot = null;
        this.lastSnapshotObservedAt = null;
        this.resetSnapshotRequestState();
        this.requiresTaggedSnapshot = true;
        if (!event.online) {
          this.peers.delete(event.deviceId);
          this.confirmedPeers.delete(event.deviceId);
        } else {
          this.beginDiscoveryRound();
        }
        this.requestSnapshot(false);
        this.reconcile();
        return;
      case 'push':
        this.handlePush(event.sourceDeviceId, event.payload);
    }
  }

  private handlePush(sourceDeviceId: string, payload: unknown): void {
    if (!isImSchedulerFrame(payload) || !this.isAuthoritativePeer(sourceDeviceId)) return;
    if (payload.kind === 'probe') {
      this.observePeerProbe(sourceDeviceId, payload);
      this.sendAdvertisement(sourceDeviceId, payload.nonce);
      this.reconcile();
      return;
    }
    if (payload.inReplyTo !== this.discoveryNonce) return;
    this.confirmedPeers.add(sourceDeviceId);
    this.peers.set(sourceDeviceId, { sentAt: payload.sentAt, frame: payload });
    for (const runtime of [payload.runtime, ...(payload.runtimeGaps ?? [])]) {
      if (runtime?.state === 'dirty') this.runtimeGaps.adopt(runtime);
    }
    if (this.isDiscoveryComplete()) this.cancelDiscoveryRetry();
    this.reconcile();
  }

  private isAuthoritativePeer(deviceId: string): boolean {
    return this.snapshot?.peers.some((peer) => peer.deviceId === deviceId) === true;
  }

  private observePeerProbe(
    sourceDeviceId: string,
    payload: Extract<ImSchedulerFrame, { kind: 'probe' }>,
  ): void {
    this.peers.set(sourceDeviceId, {
      sentAt: payload.sentAt,
      frame: {
        kind: 'advertisement',
        sentAt: payload.sentAt,
        channels: payload.channels,
        ...(payload.runtime ? { runtime: payload.runtime } : {}),
        ...(payload.runtimeGaps ? { runtimeGaps: payload.runtimeGaps } : {}),
      },
    });
    // A probe can be delayed across a binding reset and carries no response
    // tag for the receiver's current discovery round. Its channel view is
    // useful for election convergence, but runtime gaps are only authoritative
    // when returned in an advertisement replying to our current nonce.
  }

  private beginDiscoveryRound(options: { resetRetryAttempt?: boolean } = {}): void {
    this.cancelDiscoveryRetry(false);
    if (options.resetRetryAttempt !== false) this.discoveryRetryAttempt = 0;
    this.discoveryNonce = this.nonceFactory();
    this.peers.clear();
    this.confirmedPeers.clear();
    this.publishProbeToVisiblePeers();
    this.scheduleDiscoveryRetry();
  }

  private publishProbeToVisiblePeers(): void {
    const channel = this.getLocalChannel();
    for (const peer of this.snapshot?.peers ?? []) {
      this.sendPushSafely(peer.deviceId, {
        kind: 'probe',
        sentAt: Date.now(),
        nonce: this.discoveryNonce,
        channels: channel ? [channel] : [],
      });
    }
  }

  private isDiscoveryComplete(): boolean {
    return (
      this.snapshot !== null &&
      this.snapshot.selfDeviceId === this.transport.selfDeviceId &&
      this.snapshot.peers.every((peer) => this.confirmedPeers.has(peer.deviceId))
    );
  }

  private scheduleDiscoveryRetry(): void {
    if (
      this.discoveryRetryTimer ||
      !this.started ||
      this.transport.getStatus() !== 'online' ||
      !this.transport.isOwner() ||
      this.isDiscoveryComplete() ||
      this.discoveryRetryAttempt >= this.maxDiscoveryRetries
    )
      return;

    const nonce = this.discoveryNonce;
    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      if (!this.started || nonce !== this.discoveryNonce || this.isDiscoveryComplete()) return;
      this.discoveryRetryAttempt += 1;
      const roundNonce = this.discoveryNonce;
      const requestId = this.requestSnapshot(true);
      if (!this.started || roundNonce !== this.discoveryNonce) return;
      this.publishProbeToVisiblePeers();
      if (this.discoveryRetryAttempt >= this.maxDiscoveryRetries) {
        // Wait for the final refresh response before opening another round.
        // A bounded timeout below keeps a lost response from blocking recovery.
        this.snapshotRefreshPending = false;
        if (this.awaitingSnapshot && this.snapshotRequestId === requestId) {
          this.scheduleFinalSnapshotTimeout(roundNonce, requestId);
        } else {
          this.resetSnapshotRequestState();
          this.beginDiscoveryRound();
        }
      } else {
        this.scheduleDiscoveryRetry();
      }
      this.reconcile();
    }, this.discoveryRetryDelayMs);
    this.discoveryRetryTimer.unref?.();
  }

  private cancelDiscoveryRetry(resetRetryAttempt = true): void {
    if (this.discoveryRetryTimer) clearTimeout(this.discoveryRetryTimer);
    this.discoveryRetryTimer = null;
    if (resetRetryAttempt) this.discoveryRetryAttempt = 0;
  }

  private requestSnapshot(preserveRetryAttempt: boolean): string {
    const accountGeneration = this.snapshotAccountGeneration;
    const requestId = this.nonceFactory();
    this.snapshotRequestId = requestId;
    this.awaitingSnapshot = true;
    this.snapshotRefreshPending = preserveRetryAttempt;
    try {
      const result = this.transport.requestSnapshot(accountGeneration, requestId);
      void Promise.resolve(result).catch(() => {
        this.handleSnapshotRequestFailure(accountGeneration, requestId);
      });
    } catch {
      this.handleSnapshotRequestFailure(accountGeneration, requestId);
    }
    return requestId;
  }

  private handleSnapshotRequestFailure(accountGeneration: string, requestId: string): void {
    if (
      !this.started ||
      accountGeneration !== this.snapshotAccountGeneration ||
      requestId !== this.snapshotRequestId ||
      !this.awaitingSnapshot
    ) {
      return;
    }
    const retryExhausted = this.discoveryRetryAttempt >= this.maxDiscoveryRetries;
    this.resetSnapshotRequestState();
    this.requiresTaggedSnapshot = true;
    if (retryExhausted) this.beginDiscoveryRound();
    this.reconcile();
  }

  private scheduleFinalSnapshotTimeout(roundNonce: string, requestId: string): void {
    if (this.discoveryRetryTimer) clearTimeout(this.discoveryRetryTimer);
    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      if (
        !this.started ||
        roundNonce !== this.discoveryNonce ||
        requestId !== this.snapshotRequestId ||
        !this.awaitingSnapshot
      ) {
        return;
      }
      this.resetSnapshotRequestState();
      this.beginDiscoveryRound();
      this.reconcile();
    }, this.snapshotResponseTimeoutMs);
    this.discoveryRetryTimer.unref?.();
  }

  private resetSnapshotRequestState(): void {
    this.snapshotRequestId = null;
    this.awaitingSnapshot = false;
    this.snapshotRefreshPending = false;
  }

  private invalidateAuthoritativeSnapshot(): void {
    this.cancelDiscoveryRetry();
    this.snapshot = null;
    this.lastSnapshotObservedAt = null;
    this.resetSnapshotRequestState();
    this.requiresTaggedSnapshot = true;
    this.peers.clear();
    this.confirmedPeers.clear();
  }

  private sendAdvertisement(peerDeviceId: string, inReplyTo?: string): void {
    const channel = this.getLocalChannel();
    this.sendPushSafely(peerDeviceId, {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: channel ? [channel] : [],
      ...(inReplyTo ? { inReplyTo } : {}),
    });
  }

  private sendPushSafely(peerDeviceId: string, payload: ImSchedulerFrame): void {
    try {
      this.transport.sendPush(peerDeviceId, payload);
    } catch {
      // A single peer's queue/relay failure must not abort the rest of the
      // discovery round. The bounded retry timer remains the recovery path.
    }
  }

  private reconcile(): void {
    const channel = this.getLocalChannel();
    if (!this.started) return;
    if (this.transport.getStatus() !== 'online') {
      this.cancelDiscoveryRetry();
      this.publishDecision({ state: 'standby', channel, reason: 'relay-offline' });
      return;
    }
    if (!this.transport.isOwner()) {
      this.cancelDiscoveryRetry();
      this.publishDecision({ state: 'standby', channel, reason: 'not-owner' });
      return;
    }
    if (!channel) {
      this.scheduleDiscoveryRetry();
      this.publishDecision({ state: 'standby', channel: null, reason: 'missing-binding' });
      return;
    }
    if (!this.snapshot || this.snapshot.selfDeviceId !== this.transport.selfDeviceId) {
      this.scheduleDiscoveryRetry();
      this.publishDecision({ state: 'standby', channel, reason: 'missing-snapshot' });
      return;
    }
    if (this.snapshot.peers.some((peer) => !this.confirmedPeers.has(peer.deviceId))) {
      this.scheduleDiscoveryRetry();
      this.publishDecision({ state: 'standby', channel, reason: 'incomplete-peer-view' });
      return;
    }

    this.cancelDiscoveryRetry();

    const devices: SchedulerDevice[] = [
      {
        deviceId: this.transport.selfDeviceId,
        online: true,
        platform: this.transport.platform,
        channels: [channel],
        lastSeenAt: this.snapshot.observedAt,
      },
      ...this.snapshot.peers.map((peer) => ({
        deviceId: peer.deviceId,
        online: true,
        platform: peer.platform,
        channels: this.peers.get(peer.deviceId)?.frame.channels ?? [],
        lastSeenAt: this.peers.get(peer.deviceId)?.sentAt ?? 0,
      })),
    ];
    const winner = selectIngressDevice('discord', channel.identity, devices);
    this.publishDecision(
      winner === this.transport.selfDeviceId
        ? { state: 'active', channel, reason: 'elected' }
        : { state: 'standby', channel, reason: 'peer-won' },
    );
  }

  private publishDecision(decision: SchedulerDecision): void {
    if (
      this.decision.state === decision.state &&
      this.decision.reason === decision.reason &&
      this.decision.channel?.identity === decision.channel?.identity
    )
      return;
    this.decision = decision;
    this.onDecision?.(decision);
  }
}
