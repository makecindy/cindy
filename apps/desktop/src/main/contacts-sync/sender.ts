import type { ContactsSyncClock } from '@cindy/maker-core';

import type { LanContactsSyncTransport } from './lanTransport.js';
import type { ContactsSyncDatabaseSource } from './contactsSyncCodec.js';
import { encodeContactsSyncDatabaseState, type ContactsSyncWireFrame } from './wire.js';

interface OutboundTransport {
  getSelfDeviceId(): string | null;
  isPeerAllowed(deviceId: string): boolean;
  sendRelayFrame(deviceId: string, frame: ContactsSyncWireFrame): void | Promise<void>;
}

const RELAY_BACKPRESSURE_RETRY_MS = 50;
const RELAY_BACKPRESSURE_TIMEOUT_MS = 30_000;

export interface ContactsSyncOutboundContext {
  generation: number;
  ownerId: string;
  selfDeviceId: string;
  transport: OutboundTransport;
  directTransport: LanContactsSyncTransport | null;
  codecAbortSignal: AbortSignal;
}

interface ContactsSyncOutboundDependencies {
  getGeneration(): number;
  getOwnerId(): string | null;
  getTransport(): OutboundTransport | null;
  getDirectTransport(): LanContactsSyncTransport | null;
  getCodecAbortSignal(): AbortSignal;
  isEnabled(): boolean;
  getIdentity(): { privateKey: string; publicKey: string };
  getPeerPublicKey(deviceId: string): string | null;
  getDatabaseSource(): ContactsSyncDatabaseSource;
  getKnownClocks(deviceId: string): ContactsSyncClock[] | undefined;
  getKnownMergeClocks(deviceId: string): ContactsSyncClock[] | undefined;
  peerSupportsMergeRedirects(deviceId: string): boolean;
  getPeerDeliveryEpoch(deviceId: string): number;
  onLocalMaterialized(): void;
  announceKey(deviceId: string): void;
  onError(error: unknown): void;
}

/**
 * 发送期间始终使用启动时捕获的 owner、transport 与 LAN 实例。
 * 任何 await 之后都会重新验证上下文，避免账号切换时把旧 owner 的密文转发给新连接。
 */
export class ContactsSyncOutbound {
  constructor(private readonly deps: ContactsSyncOutboundDependencies) {}

  capture(): ContactsSyncOutboundContext | null {
    const ownerId = this.deps.getOwnerId();
    const transport = this.deps.getTransport();
    const selfDeviceId = transport?.getSelfDeviceId();
    if (!ownerId || !transport || !selfDeviceId || !this.deps.isEnabled()) return null;
    return {
      generation: this.deps.getGeneration(),
      ownerId,
      selfDeviceId,
      transport,
      directTransport: this.deps.getDirectTransport(),
      codecAbortSignal: this.deps.getCodecAbortSignal(),
    };
  }

  isCurrent(context: ContactsSyncOutboundContext): boolean {
    return (
      context.generation === this.deps.getGeneration() &&
      context.transport === this.deps.getTransport() &&
      context.ownerId === this.deps.getOwnerId() &&
      context.selfDeviceId === context.transport.getSelfDeviceId() &&
      context.codecAbortSignal === this.deps.getCodecAbortSignal() &&
      !context.codecAbortSignal.aborted &&
      this.deps.isEnabled()
    );
  }

  async ensureKeyThenSend(
    deviceId: string,
    requestReply: boolean,
    context: ContactsSyncOutboundContext,
  ): Promise<void> {
    try {
      if (!this.canSend(context, deviceId)) return;
      if (!this.deps.getPeerPublicKey(deviceId)) {
        this.deps.announceKey(deviceId);
        return;
      }
      await this.send(deviceId, requestReply, context);
    } catch (error) {
      if (this.isCurrent(context)) this.deps.onError(error);
    }
  }

  async send(
    deviceId: string,
    requestReply: boolean,
    expectedContext?: ContactsSyncOutboundContext,
  ): Promise<void> {
    const context = expectedContext ?? this.capture();
    if (!context || !this.canSend(context, deviceId)) return;

    const identity = this.deps.getIdentity();
    const peerKey = this.deps.getPeerPublicKey(deviceId);
    if (!peerKey) {
      this.deps.announceKey(deviceId);
      return;
    }
    const peerDeliveryEpoch = this.deps.getPeerDeliveryEpoch(deviceId);
    const knownClocks = this.deps.getKnownClocks(deviceId);
    const knownMergeClocks = this.deps.getKnownMergeClocks(deviceId);
    const encoded = await encodeContactsSyncDatabaseState({
      database: {
        source: this.deps.getDatabaseSource(),
        ...(knownClocks ? { knownClocks } : {}),
        ...(knownMergeClocks ? { knownMergeClocks } : {}),
        peerSupportsMergeRedirects: this.deps.peerSupportsMergeRedirects(deviceId),
        ...(requestReply ? { requestReply: true } : {}),
      },
      ownPrivateKey: identity.privateKey,
      ownPublicKey: identity.publicKey,
      peerPublicKey: peerKey,
      srcDeviceId: context.selfDeviceId,
      dstDeviceId: deviceId,
      signal: context.codecAbortSignal,
    });
    if (!this.isCurrent(context)) return;
    if (encoded.materialized) this.deps.onLocalMaterialized();
    if (!this.canSend(context, deviceId, peerDeliveryEpoch)) return;

    for (const frame of encoded.frames) {
      if (!this.canSend(context, deviceId, peerDeliveryEpoch)) return;
      let sentDirect: boolean | undefined;
      try {
        sentDirect = await context.directTransport?.send(deviceId, frame);
      } catch (error) {
        if (!this.isCurrent(context)) return;
        throw error;
      }
      if (!this.canSend(context, deviceId, peerDeliveryEpoch)) return;
      if (!sentDirect) {
        await this.sendRelayFrame(context, deviceId, frame, peerDeliveryEpoch);
      }
    }
  }

  private async sendRelayFrame(
    context: ContactsSyncOutboundContext,
    deviceId: string,
    frame: ContactsSyncWireFrame,
    peerDeliveryEpoch: number,
  ): Promise<void> {
    const deadline = Date.now() + RELAY_BACKPRESSURE_TIMEOUT_MS;
    while (this.canSend(context, deviceId, peerDeliveryEpoch)) {
      try {
        await context.transport.sendRelayFrame(deviceId, frame);
        return;
      } catch (error) {
        if (!isBackpressure(error) || Date.now() >= deadline) throw error;
        await delay(RELAY_BACKPRESSURE_RETRY_MS);
      }
    }
  }

  private canSend(
    context: ContactsSyncOutboundContext,
    deviceId: string,
    peerDeliveryEpoch?: number,
  ): boolean {
    return (
      this.isCurrent(context) &&
      context.transport.isPeerAllowed(deviceId) &&
      (peerDeliveryEpoch === undefined ||
        this.deps.getPeerDeliveryEpoch(deviceId) === peerDeliveryEpoch)
    );
  }
}

function isBackpressure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'BACKPRESSURE'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
