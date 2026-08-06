/** Same-account Desktop scheduler for the personal Discord bot only. */

import { randomUUID } from 'node:crypto';

import type { DiscordIM, IMStatus } from '@cindy/im';

import {
  getSelfDeviceId,
  getDeviceLinkStatus,
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
  isImSchedulerFrame,
  isSchedulerChannelIdentity,
  type SchedulerAdvertisementFrame,
} from './protocol';
import { isDesktopSchedulerPlatform, selectIngressDevice } from './state';

const log = createLogger('im:discord-scheduler');
const DISCOVERY_GRACE_MS = 3_500;
const ADVERTISEMENT_INTERVAL_MS = 2_000;
const PEER_STALE_MS = 8_000;
const ACTIVATION_RETRY_MS = 10_000;
const RUNTIME_RECONNECT_GRACE_MS = 15_000;

interface PeerAdvertisement {
  deviceId: string;
  sentAt: number;
  lastSeenAt: number;
  channels: SchedulerAdvertisementFrame['channels'];
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
  private started = false;
  private deviceLinkReady = false;
  private schedulerHooksInstalled = false;

  constructor(private readonly discord: DiscordIM) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.deviceLinkReady = getDeviceLinkStatus() === 'online';
    this.discord.setSchedulerHooks({
      isTransportAllowed: (identity) => this.isLocalIngress(identity),
      onConfigurationChanged: () => this.notifyLocalConfigurationChanged(),
    });
    this.schedulerHooksInstalled = true;
    if (this.discord.getStatus().kind === 'connected') {
      this.connectedIdentity = this.discord.getSchedulerIdentity();
    }
    this.offDiscordStatus = this.discord.onStatusChange((status) => {
      this.handleDiscordStatusChanged(status);
    });
    this.offPresence = onDeviceLinkPresenceChanged((snapshot) => {
      if (!snapshot.online || !isDesktopSchedulerPlatform(snapshot.platform)) {
        this.peers.delete(snapshot.deviceId);
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
        this.peers.clear();
        void this.ensureStandby();
      } else {
        this.beginDiscoveryGrace();
        this.advertiseAll();
      }
      void this.reconcile();
    });
    this.offPush = onDeviceLinkPush(IM_SCHEDULER_PUSH_CHANNEL, (source, payload) => {
      if (!isImSchedulerFrame(payload)) return;
      if (payload.kind === 'probe') {
        this.confirmedPeers.add(source);
        this.pendingProbePeers.delete(source);
        this.peers.set(source, {
          deviceId: source,
          sentAt: payload.sentAt,
          lastSeenAt: Date.now(),
          channels: payload.channels,
        });
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
      this.peers.set(source, {
        deviceId: source,
        sentAt: payload.sentAt,
        lastSeenAt: Date.now(),
        channels: payload.channels,
      });
      void this.reconcile();
    });
    this.offOwnership = onDeviceLinkOwnershipChanged((owner) => {
      if (owner) {
        this.beginDiscoveryGrace();
        this.advertiseAll();
      }
      void this.reconcile();
    });
    this.advertisementTimer = setInterval(() => {
      this.advertiseAll();
      for (const peer of listOnlineDesktopDevices()) {
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

  async finishStop(options: { transportDisposed?: boolean } = {}): Promise<void> {
    if (!this.schedulerHooksInstalled) return;
    try {
      if (!options.transportDisposed || this.discord.isSchedulerTransportActive()) {
        try {
          await this.discord.enterSchedulerStandby();
        } catch (error) {
          log.warn('discord scheduler stop standby failed', error);
        }
      }
      await this.reconcileTail.catch(() => undefined);
    } finally {
      this.discord.setSchedulerHooks(null);
      this.schedulerHooksInstalled = false;
    }
    this.peers.clear();
    this.confirmedPeers.clear();
    this.pendingProbePeers.clear();
    this.discoveryNonce = '';
    this.desired = null;
    this.desiredIdentity = null;
    this.lastActivationAttemptAt = 0;
  }

  async reconcile(): Promise<void> {
    if (!this.started) return;
    if (this.reconnectWithdrawal) await this.reconnectWithdrawal;
    const current = this.reconcileTail.catch(() => undefined).then(async () => {
      if (!this.started) return;
      if (!this.deviceLinkReady || !isDeviceLinkOwner()) {
        await this.ensureStandby();
        return;
      }
      if (Date.now() < this.discoveryDeadline) return;
      const self = getSelfDeviceId();
      const identity = this.discord.getSchedulerIdentity();
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
      if (this.isLocalIngress(identity, devices)) await this.ensureActive(identity);
      else await this.ensureStandby(identity, this.hasRemoteCandidate(identity));
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
    const devices = [{
      deviceId: self,
      online: true,
      platform: process.platform as string,
      lastSeenAt: now,
      channels: [{ channel: 'discord' as const, identity }],
    }];
    for (const peer of listOnlineDesktopDevices()) {
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
    if (sameIntent && Date.now() - this.lastActivationAttemptAt < ACTIVATION_RETRY_MS) return;
    this.lastActivationAttemptAt = Date.now();
    try {
      await this.discord.init();
      if (!this.discord.isSchedulerTransportActive()) {
        this.markActivationFailure(identity);
        return;
      }
      this.clearActivationFailure();
      if (!this.isLocalIngress(identity) && this.discord.isSchedulerTransportActive()) {
        await this.ensureStandby(identity);
      }
    } catch (error) {
      log.warn('discord scheduler activation failed', error);
      this.markActivationFailure(identity);
    }
  }

  private async ensureStandby(
    identity = this.discord.getSchedulerIdentity() ?? 'discord',
    clearRuntimeMarker = false,
  ): Promise<void> {
    this.desired = 'standby';
    this.desiredIdentity = identity;
    this.lastActivationAttemptAt = 0;
    if (!this.discord.isSchedulerTransportActive()) return;
    try {
      await this.discord.enterSchedulerStandby({ clearRuntimeActiveMarker: clearRuntimeMarker });
    } catch (error) {
      log.warn('discord scheduler standby failed', error);
    }
  }

  private notifyLocalConfigurationChanged(): void {
    if (!this.started) return;
    // A new local Discord identity is not authoritative until the peer view has
    // had a full round trip to advertise and confirm the binding. Reset the
    // grace window before reconciling so two Desktops configured at the same
    // time cannot both treat the previous empty advertisement as final.
    this.peers.clear();
    this.confirmedPeers.clear();
    this.connectedIdentity = null;
    this.withdrawingIdentity = null;
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
    try {
      // Destroy the reconnecting Gateway before publishing an empty
      // advertisement. Releasing the election first would briefly allow a
      // second device to connect while this client could still resume.
      await this.discord.enterSchedulerStandby();
    } catch (error) {
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
    for (const peer of listOnlineDesktopDevices()) this.advertise(peer.deviceId);
  }

  private advertise(deviceId: string, inReplyTo?: string): void {
    const frame: SchedulerAdvertisementFrame = {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: this.advertisedChannels(),
      ...(inReplyTo ? { inReplyTo } : {}),
    };
    sendDeviceLinkPush(deviceId, IM_SCHEDULER_PUSH_CHANNEL, frame);
  }

  private probeAll(): void {
    for (const peer of listOnlineDesktopDevices()) this.probe(peer.deviceId);
  }

  private probe(deviceId: string): void {
    if (!this.discoveryNonce) return;
    this.pendingProbePeers.add(deviceId);
    sendDeviceLinkPush(deviceId, IM_SCHEDULER_PUSH_CHANNEL, {
      kind: 'probe',
      sentAt: Date.now(),
      nonce: this.discoveryNonce,
      channels: this.advertisedChannels(),
    });
  }

  private advertisedChannels(): SchedulerAdvertisementFrame['channels'] {
    const identity = this.discord.getSchedulerIdentity();
    return identity
      && !this.isActivationCoolingDown(identity)
      && isSchedulerChannelIdentity({ channel: 'discord', identity })
      ? [{ channel: 'discord' as const, identity }]
      : [];
  }

  private dropStalePeers(now: number): void {
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeenAt <= PEER_STALE_MS) continue;
      this.peers.delete(deviceId);
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
    return listOnlineDesktopDevices().some((peer) => {
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

  private clearActivationFailure(): void {
    this.activationCooldownUntil = 0;
    if (this.activationRetryTimer) clearTimeout(this.activationRetryTimer);
    this.activationRetryTimer = null;
  }

  private beginDiscoveryGrace(): void {
    this.discoveryNonce = randomUUID().replaceAll('-', '');
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
    if (this.connectedIdentity && this.discord.getStatus().kind === 'connecting') {
      this.armReconnectGrace(this.connectedIdentity);
    }
  }
}
