/** Same-account Desktop scheduler for the personal Discord bot only. */

import { randomUUID } from 'node:crypto';

import type { DiscordIM, IMStatus } from '@cindy/im';

import {
  getSelfDeviceId,
  getDeviceLinkStatus,
  isDeviceRevoked,
  isDeviceLinkOwner,
  listOnlineDesktopDevices,
  onDeviceLinkOwnershipChanged,
  onDeviceLinkPresenceChanged,
  onDeviceLinkPush,
  onDeviceLinkStatusChanged,
  sendDeviceLinkPush,
} from '../../device-link';
import { createLogger } from '../../logger';
import {
  IM_SCHEDULER_PUSH_CHANNEL,
  MAX_RUNTIME_GAPS,
  isImSchedulerFrame,
  isSchedulerChannelIdentity,
  type SchedulerAdvertisementFrame,
  type SchedulerRuntimeFrame,
} from './protocol';
import { fetchSchedulerDesktopDeviceSnapshot } from './deviceSnapshot';
import { isDesktopSchedulerPlatform, selectIngressDevice } from './state';

const log = createLogger('im:discord-scheduler');
const DISCOVERY_GRACE_MS = 3_500;
const ADVERTISEMENT_INTERVAL_MS = 2_000;
const PEER_STALE_MS = 8_000;
const ACTIVATION_RETRY_MS = 10_000;
const RUNTIME_RECONNECT_GRACE_MS = 15_000;
const INITIAL_ACTIVATION_TIMEOUT_MS = 15_000;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeGenerationKey(identity: string, generation: string): string {
  return `${identity}\0${generation}`;
}

interface PeerAdvertisement {
  deviceId: string;
  sentAt: number;
  lastSeenAt: number;
  channels: SchedulerAdvertisementFrame['channels'];
  runtime?: SchedulerRuntimeFrame;
  runtimeGaps?: SchedulerRuntimeFrame[];
}

export class ImSchedulerManager {
  private readonly peers = new Map<string, PeerAdvertisement>();
  private desired: 'active' | 'standby' | null = null;
  private desiredIdentity: string | null = null;
  private lastActivationAttemptAt = 0;
  private reconcileTail = Promise.resolve();
  private offPresence: (() => void) | null = null;
  private offPush: (() => void) | null = null;
  private offOwnership: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private offDiscordStatus: (() => void) | null = null;
  private advertisementTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryDeadline = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private activationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectWithdrawal: Promise<void> | null = null;
  private activationCooldownUntil = 0;
  private connectedIdentity: string | null = null;
  private withdrawingIdentity: string | null = null;
  private discoveryNonce = '';
  private readonly confirmedPeers = new Set<string>();
  private readonly pendingProbePeers = new Set<string>();
  private readonly liveDesktopPresence = new Map<string, string>();
  private presenceMembershipVersion = 0;
  private authoritativeDesktopPeers: Map<string, string> | null = null;
  private snapshotRequest: { nonce: string; promise: Promise<void> } | null = null;
  private readonly resolvedRuntimeGenerations = new Set<string>();
  private readonly resolvedRuntimeGenerationOrder: string[] = [];
  private localRuntime: SchedulerRuntimeFrame | null = null;
  private readonly runtimeGaps = new Map<string, SchedulerRuntimeFrame>();
  private readonly pendingCleanHandoffs = new Map<string, { identity: string; generation: string }>();
  private started = false;
  private deviceLinkReady = false;
  private schedulerHooksInstalled = false;
  private transportWasConnectingAtStop: boolean | null = null;

  constructor(private readonly discord: DiscordIM) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.transportWasConnectingAtStop = null;
    this.deviceLinkReady = getDeviceLinkStatus() === 'online';
    this.discord.setSchedulerHooks({
      isTransportAllowed: (identity) => this.isLocalIngress(identity),
      onConfigurationChanged: () => this.notifyLocalConfigurationChanged(),
    });
    this.schedulerHooksInstalled = true;
    this.liveDesktopPresence.clear();
    for (const peer of this.listSchedulerPeers()) {
      this.liveDesktopPresence.set(peer.deviceId, peer.platform);
    }
    if (this.discord.getStatus().kind === 'connected') {
      this.connectedIdentity = this.discord.getSchedulerIdentity();
      if (this.connectedIdentity) this.beginLocalRuntime(this.connectedIdentity);
    }
    this.offDiscordStatus = this.discord.onStatusChange((status) => {
      this.handleDiscordStatusChanged(status);
    });
    this.offPresence = onDeviceLinkPresenceChanged((snapshot) => {
      const eligibleDesktop = snapshot.online
        && isDesktopSchedulerPlatform(snapshot.platform)
        && !isDeviceRevoked(snapshot.deviceId);
      const previousPlatform = this.liveDesktopPresence.get(snapshot.deviceId);
      if (eligibleDesktop) {
        if (previousPlatform !== snapshot.platform) {
          this.liveDesktopPresence.set(snapshot.deviceId, snapshot.platform);
          this.presenceMembershipVersion += 1;
        }
      } else if (this.liveDesktopPresence.delete(snapshot.deviceId)) {
        this.presenceMembershipVersion += 1;
      }
      const snapshotIncludedPeer = this.authoritativeDesktopPeers?.has(snapshot.deviceId) === true;
      if (
        this.authoritativeDesktopPeers
        && eligibleDesktop !== snapshotIncludedPeer
      ) {
        // Membership changed after the REST completion snapshot. Start a new
        // generation so an arriving peer cannot race an election based on the
        // previous account-wide view, and an offline peer does not leave the
        // scheduler fail-closed forever.
        this.beginDiscoveryGrace();
      }
      if (
        !snapshot.online
        || !isDesktopSchedulerPlatform(snapshot.platform)
        || isDeviceRevoked(snapshot.deviceId)
      ) {
        this.removePeer(snapshot.deviceId);
        this.confirmedPeers.delete(snapshot.deviceId);
        this.pendingProbePeers.delete(snapshot.deviceId);
      } else {
        this.advertise(snapshot.deviceId);
        if (!this.confirmedPeers.has(snapshot.deviceId)) this.probe(snapshot.deviceId);
      }
      void this.reconcile();
    });
    this.offStatus = onDeviceLinkStatusChanged((status) => {
      this.deviceLinkReady = status === 'online';
      if (!this.deviceLinkReady) {
        // Relay loss can happen while the serialized reconcile tail is
        // waiting for a long handoff drain. Close the Gateway ingress first,
        // otherwise a peer may take over after our presence expires while
        // this process still receives Discord events.
        this.closeSchedulerIngressImmediately('relay-offline');
        this.adoptActiveRuntimeFromAllPeers();
        this.peers.clear();
        if (this.liveDesktopPresence.size > 0) {
          this.liveDesktopPresence.clear();
          this.presenceMembershipVersion += 1;
        }
        void this.ensureStandby();
      } else {
        this.beginDiscoveryGrace();
        this.advertiseAll();
      }
      void this.reconcile();
    });
    this.offPush = onDeviceLinkPush(IM_SCHEDULER_PUSH_CHANNEL, (source, payload) => {
      if (isDeviceRevoked(source)) {
        this.removePeer(source);
        this.confirmedPeers.delete(source);
        this.pendingProbePeers.delete(source);
        void this.reconcile();
        return;
      }
      if (!isImSchedulerFrame(payload)) return;
      if (payload.kind === 'probe') {
        // A probe carries the sender's state, but it does not prove that the
        // sender observed our current discovery generation. Only an explicit
        // reply to this.discoveryNonce can confirm a peer after local config
        // changes; otherwise a delayed pre-change probe could authorize both
        // Desktops to activate from incompatible snapshots.
        const previous = this.peers.get(source);
        const alreadyConfirmed = this.confirmedPeers.has(source);
        if (alreadyConfirmed && (!previous || payload.sentAt >= previous.sentAt)) {
          this.observePeerRuntime(payload.runtime, payload.runtimeGaps);
          this.peers.set(source, {
            deviceId: source,
            sentAt: payload.sentAt,
            lastSeenAt: Date.now(),
            channels: payload.channels,
            runtime: payload.runtime,
            runtimeGaps: payload.runtimeGaps,
          });
        }
        this.advertise(source, payload.nonce);
        void this.reconcile();
        return;
      }
      if (payload.inReplyTo === this.discoveryNonce) {
        this.confirmedPeers.add(source);
        this.pendingProbePeers.delete(source);
      } else if (!this.confirmedPeers.has(source)) {
        return;
      }
      const previous = this.peers.get(source);
      if (previous && payload.sentAt < previous.sentAt) return;
      this.observePeerRuntime(payload.runtime, payload.runtimeGaps);
      this.peers.set(source, {
        deviceId: source,
        sentAt: payload.sentAt,
        lastSeenAt: Date.now(),
        channels: payload.channels,
        runtime: payload.runtime,
        runtimeGaps: payload.runtimeGaps,
      });
      void this.reconcile();
    });
    this.offOwnership = onDeviceLinkOwnershipChanged((owner) => {
      if (owner) {
        this.beginDiscoveryGrace();
        this.advertiseAll();
      } else {
        // Ownership can change while reconcileTail is waiting for a remote
        // handoff drain. Close this process's Gateway ingress immediately so
        // a same-device replacement can never overlap that drain; the queued
        // reconcile still performs the ordered runtime cleanup afterwards.
        this.closeSchedulerIngressImmediately('ownership-loss');
      }
      void this.reconcile();
    });
    this.advertisementTimer = setInterval(() => {
      if (!this.authoritativeDesktopPeers) this.refreshAuthoritativeDesktopSnapshot();
      this.advertiseAll();
      for (const peer of this.listSchedulerPeers()) {
        if (!this.confirmedPeers.has(peer.deviceId)) this.probe(peer.deviceId);
      }
      void this.reconcile();
    }, ADVERTISEMENT_INTERVAL_MS);
    this.beginDiscoveryGrace();
    this.advertiseAll();
    await this.reconcile();
  }

  async stop(options: { preserveTransportForDispose?: boolean } = {}): Promise<void> {
    if (!this.started) return;
    this.transportWasConnectingAtStop = this.discord.isSchedulerTransportConnecting();
    this.started = false;
    if (this.advertisementTimer) clearInterval(this.advertisementTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.activationRetryTimer) clearTimeout(this.activationRetryTimer);
    if (this.reconnectGraceTimer) clearTimeout(this.reconnectGraceTimer);
    this.advertisementTimer = null;
    this.startTimer = null;
    this.activationRetryTimer = null;
    this.reconnectGraceTimer = null;
    this.reconnectWithdrawal = null;
    this.activationCooldownUntil = 0;
    this.connectedIdentity = null;
    this.withdrawingIdentity = null;
    this.pendingCleanHandoffs.clear();
    this.offPresence?.();
    this.offPush?.();
    this.offOwnership?.();
    this.offStatus?.();
    this.offDiscordStatus?.();
    this.offPresence = null;
    this.offPush = null;
    this.offOwnership = null;
    this.offStatus = null;
    this.offDiscordStatus = null;
    this.deviceLinkReady = false;

    if (options.preserveTransportForDispose) return;

    // Keep the fail-closed scheduler hooks installed until any activation
    // already queued in reconcileTail has finished. Destroying the Gateway
    // first aborts an in-flight login; its pending-credential rollback then
    // still observes started=false and cannot reconnect the previous account's
    // Bot while logout/account replacement is disposing the IM aggregate.
    await this.finishStop();
  }

  async finishStop(options: {
    transportDisposed?: boolean;
    transportWasConnecting?: boolean;
  } = {}): Promise<void> {
    if (!this.schedulerHooksInstalled) return;
    // A reconnecting discord.js client has no open ingress, but it is still
    // alive and can emit a late Resume/Ready. Treat that shutdown as dirty:
    // close the scheduler path explicitly and preserve the next-owner
    // compensation instead of advertising a falsely clean runtime.
    const transportWasConnecting = options.transportWasConnecting
      ?? this.transportWasConnectingAtStop
      ?? this.discord.isSchedulerTransportConnecting();
    try {
      if (
        !options.transportDisposed
        || this.discord.isSchedulerTransportActive()
        || transportWasConnecting
      ) {
        try {
          await this.discord.enterSchedulerStandby();
        } catch (error) {
          log.warn('discord scheduler stop standby failed', error);
        }
      }
      if (this.localRuntime && !this.discord.isSchedulerTransportActive()) {
        this.finishLocalRuntime(
          this.localRuntime.identity,
          options.transportDisposed === true && !transportWasConnecting,
        );
        // Device Link is intentionally still online during ordered shutdown,
        // so peers can distinguish a clean close from a crashed active lease.
        this.advertiseAll();
      }
      await this.reconcileTail.catch(() => undefined);
    } finally {
      try {
        this.discord.setSchedulerHooks(null);
      } finally {
        this.schedulerHooksInstalled = false;
        // ImSchedulerManager is reused across Cindy account sessions. Keep the
        // final runtime advertisement above visible to the old account's
        // peers, then discard every account-scoped runtime marker before the
        // next Device Link session can start advertising.
        this.resetAccountScopedState();
        this.transportWasConnectingAtStop = null;
      }
    }
  }

  async reconcile(): Promise<void> {
    if (!this.started) return;
    if (this.reconnectWithdrawal) await this.reconnectWithdrawal;
    const current = this.reconcileTail.catch(() => undefined).then(async () => {
      if (!this.started) return;
      if (!this.deviceLinkReady || !isDeviceLinkOwner()) {
        await this.ensureStandby(undefined, false, true);
        return;
      }
      const identity = this.discord.getSchedulerIdentity();
      if (Date.now() < this.discoveryDeadline || !this.authoritativeDesktopPeers) {
        await this.ensureStandby(identity ?? 'discord');
        return;
      }
      const self = getSelfDeviceId();
      if (!self || !identity) {
        await this.ensureStandby(identity ?? 'discord');
        return;
      }
      const now = Date.now();
      this.dropStalePeers(now);
      const devices = this.buildElectionSnapshot(self, identity, now);
      if (!devices) {
        // Presence without a fresh advertisement is an unknown candidate, not
        // evidence that the peer has no Discord binding. Fail closed until the
        // peer explicitly advertises (including an empty channel list).
        await this.ensureStandby(identity);
        return;
      }
      if (this.isLocalIngress(identity, devices)) {
        // A newly winning Desktop waits for the previous active runtime to
        // publish a clean handoff. If that peer disappears, removePeer()
        // converts its generation into a dirty compensation responsibility.
        if (!this.discord.isSchedulerTransportActive() && this.hasRemoteActiveRuntime(identity)) {
          await this.ensureStandby(identity);
          return;
        }
        await this.ensureActive(identity);
      } else {
        await this.ensureStandby(identity, this.hasRemoteCandidate(identity));
      }
    });
    this.reconcileTail = current.catch(() => undefined);
    await current;
  }

  private isLocalIngress(
    identity?: string | null,
    devices?: Array<{
      deviceId: string;
      online: boolean;
      platform: string;
      lastSeenAt: number;
      channels: SchedulerAdvertisementFrame['channels'];
    }>,
  ): boolean {
    if (!this.started || !this.deviceLinkReady || Date.now() < this.discoveryDeadline || !isDeviceLinkOwner()) return false;
    const self = getSelfDeviceId();
    const resolvedIdentity = identity ?? this.discord.getSchedulerIdentity();
    if (!self || !resolvedIdentity) return false;
    if (this.withdrawingIdentity === resolvedIdentity) return false;
    if (this.isActivationCoolingDown(resolvedIdentity)) return false;
    const now = Date.now();
    this.dropStalePeers(now);
    const snapshot = devices ?? this.buildElectionSnapshot(self, resolvedIdentity, now);
    if (!snapshot) return false;
    return selectIngressDevice('discord', resolvedIdentity, snapshot) === self;
  }

  private buildElectionSnapshot(
    self: string,
    identity: string,
    now: number,
  ): Array<{
    deviceId: string;
    online: boolean;
    platform: string;
    lastSeenAt: number;
    channels: SchedulerAdvertisementFrame['channels'];
  }> | null {
    if (!this.authoritativeDesktopPeers) return null;
    const schedulerPeers = this.listSchedulerPeers();
    const schedulerPeersById = new Map(schedulerPeers.map((peer) => [peer.deviceId, peer]));
    for (const [deviceId, platform] of this.authoritativeDesktopPeers) {
      if (isDeviceRevoked(deviceId)) continue;
      const peer = schedulerPeersById.get(deviceId);
      if (!peer || peer.platform !== platform) return null;
    }
    const devices = [{
      deviceId: self,
      online: true,
      platform: process.platform as string,
      lastSeenAt: now,
      channels: [{ channel: 'discord' as const, identity }],
    }];
    for (const peer of schedulerPeers) {
      if (!this.confirmedPeers.has(peer.deviceId)) return null;
      const advertisement = this.peers.get(peer.deviceId);
      if (!advertisement || now - advertisement.lastSeenAt > PEER_STALE_MS) return null;
      devices.push({ ...peer, channels: advertisement.channels });
    }
    return devices;
  }

  private async ensureActive(identity: string): Promise<void> {
    const sameIntent = this.desired === 'active' && this.desiredIdentity === identity;
    this.desired = 'active';
    this.desiredIdentity = identity;
    if (this.discord.isSchedulerTransportActive()) return;
    // A live discord.js client can temporarily have no ingress while the
    // Gateway is reconnecting. Do not create a second Client or mark the
    // current winner as a failed activation; the existing client will report
    // ShardReady/ShardResume when it recovers, or the reconnect grace will
    // release it deterministically if it does not.
    if (this.discord.isSchedulerTransportConnecting()) return;
    if (sameIntent && Date.now() - this.lastActivationAttemptAt < ACTIVATION_RETRY_MS) return;
    this.lastActivationAttemptAt = Date.now();
    const predecessor = this.firstRuntimeGap(identity)?.generation;
    if (predecessor) this.discord.markSchedulerOfflineGap();
    const activation = this.discord.init();
    let activationTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const activationResult = await Promise.race([
        activation.then(() => 'ready' as const),
        new Promise<'timeout'>((resolve) => {
          activationTimeout = setTimeout(() => resolve('timeout'), INITIAL_ACTIVATION_TIMEOUT_MS);
        }),
      ]);
      if (activationResult === 'timeout') {
        // The provider may still be waiting for the first Gateway handshake.
        // Withdraw this winner and let a healthy peer take over instead of
        // keeping reconcileTail occupied forever.
        void activation.catch((error) => {
          log.warn('discord scheduler activation timed out', error);
        });
        try {
          await this.discord.enterSchedulerStandby({ closeIngress: true });
        } catch (error) {
          log.warn('discord scheduler activation timeout cleanup failed', error);
        }
        this.markActivationFailure(identity);
        return;
      }
      if (!this.discord.isSchedulerTransportActive()) {
        if (this.discord.isSchedulerTransportConnecting()) return;
        this.markActivationFailure(identity);
        return;
      }
      this.beginLocalRuntime(identity, predecessor);
      this.clearActivationFailure();
      this.advertiseAll();
      if (!this.isLocalIngress(identity) && this.discord.isSchedulerTransportActive()) {
        await this.ensureStandby(identity);
      }
    } catch (error) {
      log.warn('discord scheduler activation failed', error);
      this.markActivationFailure(identity);
    } finally {
      if (activationTimeout) clearTimeout(activationTimeout);
    }
  }

  private async ensureStandby(
    identity = this.discord.getSchedulerIdentity() ?? 'discord',
    clearRuntimeMarker = false,
    closeIngress = false,
  ): Promise<void> {
    this.desired = 'standby';
    this.desiredIdentity = identity;
    this.lastActivationAttemptAt = 0;
    if (
      !this.discord.isSchedulerTransportActive()
      && !this.discord.isSchedulerTransportConnecting()
    ) {
      // Provider-side teardown can publish idle/error before reconcile gets
      // here. Retire the runtime generation even when the Gateway is already
      // gone, otherwise peers keep seeing a stale active lease indefinitely.
      if (this.localRuntime?.identity === identity && this.localRuntime.state === 'active') {
        this.finishLocalRuntime(identity, false);
        this.advertiseAll();
      }
      return;
    }
    try {
      const options = {
        ...(clearRuntimeMarker ? { clearRuntimeActiveMarker: true } : {}),
        ...(closeIngress ? { closeIngress: true } : {}),
      };
      await this.discord.enterSchedulerStandby(options);
      if (this.discord.isSchedulerTransportActive()) {
        // The winning peer may have disappeared while Discord drained an
        // already accepted turn. The provider re-checks the lease before
        // destroy and keeps the Gateway alive in that case; preserve the
        // active generation instead of publishing a stale clean handoff.
        this.desired = 'active';
        this.desiredIdentity = identity;
        this.advertiseAll();
        return;
      }
      this.finishLocalRuntime(identity, clearRuntimeMarker);
      this.advertiseAll();
    } catch (error) {
      log.warn('discord scheduler standby failed', error);
    }
  }

  private closeSchedulerIngressImmediately(reason: string): void {
    void this.discord.closeSchedulerIngress().catch((error) => {
      log.warn(`discord scheduler ${reason} ingress close failed`, error);
    });
  }

  private notifyLocalConfigurationChanged(): void {
    if (!this.started) return;
    // A new local Discord identity is not authoritative until the peer view has
    // had a full round trip to advertise and confirm the binding. Reset the
    // grace window before reconciling so two Desktops configured at the same
    // time cannot both treat the previous empty advertisement as final.
    this.finishLocalRuntime(this.localRuntime?.identity ?? 'discord', true);
    this.peers.clear();
    this.confirmedPeers.clear();
    this.connectedIdentity = null;
    this.withdrawingIdentity = null;
    this.pendingCleanHandoffs.clear();
    this.clearReconnectGrace();
    this.clearActivationFailure();
    this.beginDiscoveryGrace();
    this.advertiseAll();
    void this.reconcile();
  }

  private handleDiscordStatusChanged(status: IMStatus): void {
    if (!this.started) return;
    const identity = this.discord.getSchedulerIdentity();
    if (status.kind === 'connected') {
      this.connectedIdentity = identity;
      this.clearReconnectGrace();
      return;
    }
    if (status.kind === 'connecting') {
      if (
        identity
        && this.connectedIdentity === identity
        && !this.reconnectGraceTimer
      ) {
        this.armReconnectGrace(identity);
      }
      return;
    }

    this.connectedIdentity = null;
    this.clearReconnectGrace();
    if (status.kind !== 'error') return;
    if (!identity || this.desired !== 'active' || this.desiredIdentity !== identity) return;

    // A terminal provider error after a successful activation must release the
    // deterministic winner. Otherwise the stale winner keeps advertising its
    // identity forever and prevents a healthy standby from taking over.
    this.markLocalRuntimeDirty(identity);
    this.markActivationFailure(identity);
    void this.reconcile();
  }

  private async withdrawAfterReconnectTimeout(identity: string, discoveryNonce: string): Promise<void> {
    if (
      !this.started
      || this.discoveryNonce !== discoveryNonce
      || this.connectedIdentity !== identity
      || this.desired !== 'active'
      || this.desiredIdentity !== identity
    ) return;
    this.withdrawingIdentity = identity;
    this.connectedIdentity = null;
    // Withdraw from the election before waiting for accepted work to drain.
    // The old Gateway is already reconnecting, so its REST lease can finish
    // without keeping this Desktop advertised as the active ingress.
    this.markLocalRuntimeDirty(identity);
    this.advertiseAll();
    try {
      // Close the reconnecting Gateway before draining its accepted work. The
      // provider keeps the REST client alive for those terminal responses, but
      // a healthy peer can now observe the dirty/empty advertisement and take
      // over without waiting for an unbounded Agent turn.
      await this.discord.enterSchedulerStandby({ closeIngress: true });
      if (!this.started || this.discoveryNonce !== discoveryNonce) {
        this.withdrawingIdentity = null;
        return;
      }
    } catch (error) {
      this.markActivationFailure(identity);
      this.withdrawingIdentity = null;
      log.warn('discord scheduler reconnect timeout standby failed', error);
      return;
    }
    this.withdrawingIdentity = null;
    if (
      !this.started
      || this.discoveryNonce !== discoveryNonce
      || identity !== this.discord.getSchedulerIdentity()
    ) return;
    this.connectedIdentity = null;
    this.markActivationFailure(identity);
  }

  private clearReconnectGrace(): void {
    if (this.reconnectGraceTimer) clearTimeout(this.reconnectGraceTimer);
    this.reconnectGraceTimer = null;
  }

  private armReconnectGrace(identity: string): void {
    this.clearReconnectGrace();
    const discoveryNonce = this.discoveryNonce;
    this.reconnectGraceTimer = setTimeout(() => {
      this.reconnectGraceTimer = null;
      const withdrawal = this.withdrawAfterReconnectTimeout(identity, discoveryNonce);
      this.reconnectWithdrawal = withdrawal;
      void withdrawal.finally(() => {
        if (this.reconnectWithdrawal === withdrawal) this.reconnectWithdrawal = null;
        void this.reconcile();
      });
    }, RUNTIME_RECONNECT_GRACE_MS);
  }

  private advertiseAll(): void {
    for (const peer of this.listSchedulerPeers()) this.advertise(peer.deviceId);
  }

  private advertise(deviceId: string, inReplyTo?: string): void {
    if (isDeviceRevoked(deviceId)) return;
    const legacyRuntime = this.localRuntime ?? this.legacyRuntimeGap();
    const runtimeGapFrames = this.advertisedRuntimeGaps();
    const frame: SchedulerAdvertisementFrame = {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: this.advertisedChannels(),
      ...(legacyRuntime ? { runtime: legacyRuntime } : {}),
      ...(runtimeGapFrames ? { runtimeGaps: runtimeGapFrames } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
    };
    sendDeviceLinkPush(deviceId, IM_SCHEDULER_PUSH_CHANNEL, frame);
  }

  private probeAll(): void {
    for (const peer of this.listSchedulerPeers()) this.probe(peer.deviceId);
  }

  private probe(deviceId: string): void {
    if (!this.discoveryNonce || isDeviceRevoked(deviceId)) return;
    this.pendingProbePeers.add(deviceId);
    const legacyRuntime = this.localRuntime ?? this.legacyRuntimeGap();
    const runtimeGapFrames = this.advertisedRuntimeGaps();
    sendDeviceLinkPush(deviceId, IM_SCHEDULER_PUSH_CHANNEL, {
      kind: 'probe',
      sentAt: Date.now(),
      nonce: this.discoveryNonce,
      channels: this.advertisedChannels(),
      ...(legacyRuntime ? { runtime: legacyRuntime } : {}),
      ...(runtimeGapFrames ? { runtimeGaps: runtimeGapFrames } : {}),
    });
  }

  /** Keep older Desktops interoperable while newer peers receive every gap. */
  private legacyRuntimeGap(): SchedulerRuntimeFrame | undefined {
    return [...this.runtimeGaps.values()]
      .sort((left, right) => (
        compareCodeUnits(left.generation, right.generation)
        || compareCodeUnits(left.identity, right.identity)
      ))[0];
  }

  private advertisedRuntimeGaps(): SchedulerRuntimeFrame[] | undefined {
    if (this.runtimeGaps.size === 0) return undefined;
    if (this.runtimeGaps.size === 1 && !this.localRuntime) return undefined;
    return [...this.runtimeGaps.values()].sort((left, right) => (
      compareCodeUnits(left.generation, right.generation)
      || compareCodeUnits(left.identity, right.identity)
    ));
  }

  private advertisedChannels(): SchedulerAdvertisementFrame['channels'] {
    const identity = this.discord.getSchedulerIdentity();
    return identity
      && this.withdrawingIdentity !== identity
      && !this.isActivationCoolingDown(identity)
      && isSchedulerChannelIdentity({ channel: 'discord', identity })
      ? [{ channel: 'discord' as const, identity }]
      : [];
  }

  private dropStalePeers(now: number): void {
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeenAt <= PEER_STALE_MS) continue;
      this.removePeer(deviceId);
      this.confirmedPeers.delete(deviceId);
      this.pendingProbePeers.delete(deviceId);
      if (this.started) this.probe(deviceId);
    }
  }

  private isActivationCoolingDown(identity: string): boolean {
    if (identity !== this.discord.getSchedulerIdentity() || !this.activationCooldownUntil) return false;
    if (Date.now() < this.activationCooldownUntil) return true;
    if (this.hasRemoteCandidate(identity)) return true;
    this.clearActivationFailure();
    return false;
  }

  private markActivationFailure(identity: string): void {
    if (!this.started || identity !== this.discord.getSchedulerIdentity()) return;
    this.recordActivationGapAfterCleanHandoff(identity);
    this.activationCooldownUntil = Date.now() + ACTIVATION_RETRY_MS;
    this.advertiseAll();
    if (this.activationRetryTimer) clearTimeout(this.activationRetryTimer);
    this.activationRetryTimer = setTimeout(() => {
      this.activationRetryTimer = null;
      if (this.hasRemoteCandidate(identity)) {
        this.advertiseAll();
        return;
      }
      this.activationCooldownUntil = 0;
      this.advertiseAll();
      void this.reconcile();
    }, ACTIVATION_RETRY_MS);
  }

  private hasRemoteCandidate(identity: string): boolean {
    const now = Date.now();
    this.dropStalePeers(now);
    return this.listSchedulerPeers().some((peer) => {
      if (!this.confirmedPeers.has(peer.deviceId)) return false;
      const advertisement = this.peers.get(peer.deviceId);
      return Boolean(
        advertisement
        && now - advertisement.lastSeenAt <= PEER_STALE_MS
        && advertisement.channels.some(
          (configured) => configured.channel === 'discord' && configured.identity === identity,
        ),
      );
    });
  }

  private hasRemoteActiveRuntime(identity: string): boolean {
    const now = Date.now();
    return this.listSchedulerPeers().some((peer) => {
      if (!this.confirmedPeers.has(peer.deviceId)) return false;
      const advertisement = this.peers.get(peer.deviceId);
      return Boolean(
        advertisement
        && now - advertisement.lastSeenAt <= PEER_STALE_MS
        && advertisement.runtime?.identity === identity
        && advertisement.runtime.state === 'active',
      );
    });
  }

  private observePeerRuntime(
    runtime: SchedulerRuntimeFrame | undefined,
    runtimeGaps: SchedulerRuntimeFrame[] | undefined,
  ): void {
    if (runtime) {
      if (runtime.predecessor) {
        this.resolveRuntimeGeneration(runtime.identity, runtime.predecessor);
      }
      if (runtime.state === 'clean') {
        const pending = this.pendingCleanHandoffs.get(runtime.identity);
        if (!pending || pending.generation !== runtime.generation) {
          this.pendingCleanHandoffs.set(runtime.identity, {
            identity: runtime.identity,
            generation: runtime.generation,
          });
        }
        this.resolveRuntimeGeneration(runtime.identity, runtime.generation);
      } else if (runtime.state === 'active') {
        this.pendingCleanHandoffs.delete(runtime.identity);
        this.runtimeGaps.delete(runtimeGenerationKey(runtime.identity, runtime.generation));
      } else {
        this.adoptRuntimeGap(runtime);
      }
    }
    for (const gap of runtimeGaps ?? []) this.adoptRuntimeGap(gap);
  }

  private removePeer(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    const runtime = peer?.runtime;
    if (runtime?.state === 'active') this.adoptRuntimeGap(runtime);
    for (const gap of peer?.runtimeGaps ?? []) this.adoptRuntimeGap(gap);
    this.peers.delete(deviceId);
  }

  private adoptActiveRuntimeFromAllPeers(): void {
    for (const peer of this.peers.values()) {
      if (isDeviceRevoked(peer.deviceId)) continue;
      if (peer.runtime?.state === 'active') this.adoptRuntimeGap(peer.runtime);
      for (const gap of peer.runtimeGaps ?? []) this.adoptRuntimeGap(gap);
    }
  }

  private listSchedulerPeers(): ReturnType<typeof listOnlineDesktopDevices> {
    return listOnlineDesktopDevices().filter((peer) => {
      if (!isDeviceRevoked(peer.deviceId)) return true;
      // Drop any previously confirmed advertisement while access is revoked.
      // If access is restored later, the peer must complete a fresh probe
      // round instead of reusing pre-revocation scheduler state.
      this.removePeer(peer.deviceId);
      this.confirmedPeers.delete(peer.deviceId);
      this.pendingProbePeers.delete(peer.deviceId);
      return false;
    });
  }

  private adoptRuntimeGap(runtime: SchedulerRuntimeFrame): void {
    const key = runtimeGenerationKey(runtime.identity, runtime.generation);
    if (this.resolvedRuntimeGenerations.has(key)) return;
    if (this.localRuntime?.state === 'active' && this.localRuntime.identity === runtime.identity) return;
    if (this.runtimeGaps.has(key)) return;
    this.setRuntimeGap({
      identity: runtime.identity,
      generation: runtime.generation,
      state: 'dirty',
    });
    this.pendingCleanHandoffs.delete(runtime.identity);
  }

  private setRuntimeGap(runtime: SchedulerRuntimeFrame): void {
    const key = runtimeGenerationKey(runtime.identity, runtime.generation);
    this.runtimeGaps.set(key, runtime);
    if (this.runtimeGaps.size <= MAX_RUNTIME_GAPS) return;

    // Keep the same deterministic subset on every observer when the unresolved
    // generation set exceeds the wire-format limit. Generation is opaque, so
    // code-unit order is only a stable tie-breaker, never an age claim.
    const retained = [...this.runtimeGaps.entries()]
      .sort((left, right) => (
        compareCodeUnits(left[1].generation, right[1].generation)
        || compareCodeUnits(left[1].identity, right[1].identity)
      ))
      .slice(0, MAX_RUNTIME_GAPS);
    this.runtimeGaps.clear();
    for (const [retainedKey, gap] of retained) this.runtimeGaps.set(retainedKey, gap);
  }

  private firstRuntimeGap(identity: string): SchedulerRuntimeFrame | undefined {
    return [...this.runtimeGaps.values()]
      .filter((runtime) => runtime.identity === identity)
      .sort((left, right) => compareCodeUnits(left.generation, right.generation))[0];
  }

  private beginLocalRuntime(identity: string, predecessor?: string): void {
    if (predecessor) this.resolveRuntimeGeneration(identity, predecessor);
    this.localRuntime = {
      identity,
      generation: randomUUID().replaceAll('-', ''),
      state: 'active',
      ...(predecessor ? { predecessor } : {}),
    };
    this.pendingCleanHandoffs.delete(identity);
  }

  private recordActivationGapAfterCleanHandoff(identity: string): void {
    const pending = this.pendingCleanHandoffs.get(identity);
    if (!pending) return;
    this.setRuntimeGap({
      identity,
      generation: randomUUID().replaceAll('-', ''),
      state: 'dirty',
    });
    if (this.localRuntime?.identity === identity) this.localRuntime = null;
    this.pendingCleanHandoffs.delete(identity);
  }

  private finishLocalRuntime(identity: string, clean: boolean): void {
    if (!this.localRuntime || this.localRuntime.identity !== identity) return;
    if (this.localRuntime.state === 'clean') return;
    const runtimeClean = clean && !this.discord.hasPendingSchedulerOfflineNotice();
    const generation = this.localRuntime.generation;
    if (runtimeClean) {
      this.localRuntime = { identity, generation, state: 'clean' };
      this.resolveRuntimeGeneration(identity, generation);
    } else {
      this.localRuntime = null;
      this.setRuntimeGap({ identity, generation, state: 'dirty' });
    }
  }

  private markLocalRuntimeDirty(identity: string): void {
    this.finishLocalRuntime(identity, false);
  }

  private resolveRuntimeGeneration(identity: string, generation: string): void {
    const key = runtimeGenerationKey(identity, generation);
    if (this.resolvedRuntimeGenerations.has(key)) return;
    this.resolvedRuntimeGenerations.add(key);
    this.resolvedRuntimeGenerationOrder.push(key);
    if (this.resolvedRuntimeGenerationOrder.length > 32) {
      const oldest = this.resolvedRuntimeGenerationOrder.shift();
      if (oldest) this.resolvedRuntimeGenerations.delete(oldest);
    }
    this.runtimeGaps.delete(key);
  }

  private clearActivationFailure(): void {
    this.activationCooldownUntil = 0;
    if (this.activationRetryTimer) clearTimeout(this.activationRetryTimer);
    this.activationRetryTimer = null;
  }

  private resetAccountScopedState(): void {
    this.peers.clear();
    this.confirmedPeers.clear();
    this.pendingProbePeers.clear();
    this.liveDesktopPresence.clear();
    this.presenceMembershipVersion = 0;
    this.authoritativeDesktopPeers = null;
    this.snapshotRequest = null;
    this.resolvedRuntimeGenerations.clear();
    this.resolvedRuntimeGenerationOrder.length = 0;
    this.localRuntime = null;
    this.runtimeGaps.clear();
    this.pendingCleanHandoffs.clear();
    this.discoveryNonce = '';
    this.discoveryDeadline = 0;
    this.desired = null;
    this.desiredIdentity = null;
    this.lastActivationAttemptAt = 0;
    this.activationCooldownUntil = 0;
    this.connectedIdentity = null;
    this.withdrawingIdentity = null;
    this.reconnectWithdrawal = null;
    this.reconcileTail = Promise.resolve();
  }

  private refreshAuthoritativeDesktopSnapshot(nonce = this.discoveryNonce): void {
    if (!this.started || !this.deviceLinkReady || !nonce) return;
    if (this.snapshotRequest?.nonce === nonce) return;
    const presenceMembershipVersion = this.presenceMembershipVersion;
    const promise = fetchSchedulerDesktopDeviceSnapshot()
      .then((snapshot) => {
        if (!this.started || this.discoveryNonce !== nonce) return;
        const self = getSelfDeviceId();
        if (!self || snapshot.selfDeviceId !== self) {
          throw new Error('device-link snapshot does not match the current Desktop');
        }
        if (this.presenceMembershipVersion !== presenceMembershipVersion) {
          // A presence membership change can arrive while the REST request is
          // in flight. Never publish that stale snapshot as authoritative;
          // start a fresh nonce so the offline/online event cannot strand the
          // scheduler in standby or authorize an old peer.
          this.authoritativeDesktopPeers = null;
          this.beginDiscoveryGrace();
          return;
        }
        const visiblePeers = snapshot.peers.filter((peer) => !isDeviceRevoked(peer.deviceId));
        this.authoritativeDesktopPeers = new Map(
          visiblePeers.map((peer) => [peer.deviceId, peer.platform]),
        );
        // The full account snapshot replaces the old fixed-delay assumption.
        // Once it includes this exact online Desktop, election may proceed as
        // soon as every listed peer completes the nonce-bound advertisement.
        this.discoveryDeadline = 0;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.advertiseAll();
        for (const peer of this.listSchedulerPeers()) {
          if (!this.confirmedPeers.has(peer.deviceId)) this.probe(peer.deviceId);
        }
        void this.reconcile();
      })
      .catch((error) => {
        if (!this.started || this.discoveryNonce !== nonce) return;
        this.authoritativeDesktopPeers = null;
        log.warn('discord scheduler device snapshot failed', error);
        void this.reconcile();
      })
      .finally(() => {
        if (this.snapshotRequest?.promise === promise) this.snapshotRequest = null;
      });
    this.snapshotRequest = { nonce, promise };
  }

  private beginDiscoveryGrace(): void {
    this.adoptActiveRuntimeFromAllPeers();
    this.discoveryNonce = randomUUID().replaceAll('-', '');
    this.authoritativeDesktopPeers = null;
    this.confirmedPeers.clear();
    this.pendingProbePeers.clear();
    this.peers.clear();
    this.discoveryDeadline = Date.now() + DISCOVERY_GRACE_MS;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.reconcile();
    }, DISCOVERY_GRACE_MS);
    this.probeAll();
    this.refreshAuthoritativeDesktopSnapshot();
    if (this.connectedIdentity && this.discord.getStatus().kind === 'connecting') {
      this.armReconnectGrace(this.connectedIdentity);
    }
  }
}
