import {
  createContactsSyncDelta,
  type ContactsSyncClock,
  type ContactsSyncState,
} from '@cindy/maker-core';

import type { LanContactsSyncTransport } from './lanTransport.js';
import {
  encodeContactsSyncMessage,
  type ContactsSyncWireFrame,
} from './wire.js';

interface OutboundTransport {
  getSelfDeviceId(): string | null;
  isPeerAllowed(deviceId: string): boolean;
  sendRelayFrame(deviceId: string, frame: ContactsSyncWireFrame): void;
}

export interface ContactsSyncOutboundContext {
  generation: number;
  ownerId: string;
  selfDeviceId: string;
  transport: OutboundTransport;
  directTransport: LanContactsSyncTransport | null;
}

interface ContactsSyncOutboundDependencies {
  getGeneration(): number;
  getOwnerId(): string | null;
  getTransport(): OutboundTransport | null;
  getDirectTransport(): LanContactsSyncTransport | null;
  isEnabled(): boolean;
  getIdentity(): { privateKey: string; publicKey: string };
  getPeerPublicKey(deviceId: string): string | null;
  readLocalState(): ContactsSyncState;
  getKnownClocks(deviceId: string): ContactsSyncClock[] | undefined;
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
    };
  }

  isCurrent(context: ContactsSyncOutboundContext): boolean {
    return (
      context.generation === this.deps.getGeneration() &&
      context.transport === this.deps.getTransport() &&
      context.ownerId === this.deps.getOwnerId() &&
      context.selfDeviceId === context.transport.getSelfDeviceId() &&
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
    const fullState = this.deps.readLocalState();
    const knownClocks = this.deps.getKnownClocks(deviceId);
    const state = knownClocks
      ? createContactsSyncDelta(fullState, knownClocks)
      : fullState;
    const frames = encodeContactsSyncMessage({
      message: {
        version: 1,
        type: 'state',
        state,
        ...(requestReply ? { requestReply: true } : {}),
      },
      ownPrivateKey: identity.privateKey,
      ownPublicKey: identity.publicKey,
      peerPublicKey: peerKey,
      srcDeviceId: context.selfDeviceId,
      dstDeviceId: deviceId,
    });

    for (const frame of frames) {
      if (!this.canSend(context, deviceId)) return;
      let sentDirect: boolean | undefined;
      try {
        sentDirect = await context.directTransport?.send(deviceId, frame);
      } catch (error) {
        if (!this.isCurrent(context)) return;
        throw error;
      }
      if (!this.canSend(context, deviceId)) return;
      if (!sentDirect) context.transport.sendRelayFrame(deviceId, frame);
    }
  }

  private canSend(context: ContactsSyncOutboundContext, deviceId: string): boolean {
    return this.isCurrent(context) && context.transport.isPeerAllowed(deviceId);
  }
}
