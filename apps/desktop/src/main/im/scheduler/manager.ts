/** Same-account Desktop scheduler for the personal Discord bot only. */

import type { DiscordIM } from '@cindy/im';

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

interface PeerAdvertisement {
  deviceId: string;
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
  private advertisementTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryDeadline = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private deviceLinkReady = false;

  constructor(private readonly discord: DiscordIM) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.deviceLinkReady = getDeviceLinkStatus() === 'online';
    this.discord.setSchedulerHooks({
      isTransportAllowed: (identity) => this.isLocalIngress(identity),
      onConfigurationChanged: () => this.notifyLocalConfigurationChanged(),
    });
    this.offPresence = onDeviceLinkPresenceChanged((snapshot) => {
      if (!snapshot.online || !isDesktopSchedulerPlatform(snapshot.platform)) {
        this.peers.delete(snapshot.deviceId);
      } else {
        this.advertise(snapshot.deviceId);
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
      this.peers.set(source, {
        deviceId: source,
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
      void this.reconcile();
    }, ADVERTISEMENT_INTERVAL_MS);
    this.beginDiscoveryGrace();
    this.advertiseAll();
    await this.reconcile();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.advertisementTimer) clearInterval(this.advertisementTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.advertisementTimer = null;
    this.startTimer = null;
    this.offPresence?.();
    this.offPush?.();
    this.offOwnership?.();
    this.offStatus?.();
    this.offPresence = null;
    this.offPush = null;
    this.offOwnership = null;
    this.offStatus = null;
    this.deviceLinkReady = false;
    this.discord.setSchedulerHooks(null);
    this.peers.clear();
    this.desired = null;
    this.desiredIdentity = null;
    this.lastActivationAttemptAt = 0;
  }

  async reconcile(): Promise<void> {
    if (!this.started) return;
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
      else await this.ensureStandby(identity);
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
      if (!this.isLocalIngress(identity) && this.discord.isSchedulerTransportActive()) {
        await this.ensureStandby(identity);
      }
    } catch (error) {
      log.warn('discord scheduler activation failed', error);
    }
  }

  private async ensureStandby(identity = this.discord.getSchedulerIdentity() ?? 'discord'): Promise<void> {
    this.desired = 'standby';
    this.desiredIdentity = identity;
    this.lastActivationAttemptAt = 0;
    if (!this.discord.isSchedulerTransportActive()) return;
    try {
      await this.discord.enterSchedulerStandby();
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
    this.beginDiscoveryGrace();
    this.advertiseAll();
    void this.reconcile();
  }

  private advertiseAll(): void {
    for (const peer of listOnlineDesktopDevices()) this.advertise(peer.deviceId);
  }

  private advertise(deviceId: string): void {
    const identity = this.discord.getSchedulerIdentity();
    const channels = identity && isSchedulerChannelIdentity({ channel: 'discord', identity })
      ? [{ channel: 'discord' as const, identity }]
      : [];
    const frame: SchedulerAdvertisementFrame = {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels,
    };
    sendDeviceLinkPush(deviceId, IM_SCHEDULER_PUSH_CHANNEL, frame);
  }

  private dropStalePeers(now: number): void {
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeenAt > PEER_STALE_MS) this.peers.delete(deviceId);
    }
  }

  private beginDiscoveryGrace(): void {
    this.discoveryDeadline = Date.now() + DISCOVERY_GRACE_MS;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.reconcile();
    }, DISCOVERY_GRACE_MS);
  }
}
