/**
 * 同账号其他电脑这一侧：经 `provider-group:remote` 问组所在电脑(docs/product-rules/provider-groups.md §4–§6)。
 *
 * 组所在电脑是旧版本(`CHANNEL_NOT_ALLOWED`)或这个供应商已经没有组时，`pick` 返回 `none`，调用方照常
 * 直接在组所在电脑上运行；其他失败原样抛出，由调用方决定(分配阶段按连不上组所在电脑处理)。
 */
import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import {
  parseProviderGroupRemotePick,
  parseProviderGroupRemoteView,
  type ProviderGroupRemoteCoolCause,
  type ProviderGroupRemoteLease,
  type ProviderGroupRemotePick,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';

export type ProviderGroupRemoteInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;

export interface ProviderGroupRemoteClient {
  pick(ownerDeviceId: string, input: {
    sessionId: string;
    providerId: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    model: string;
    exclude: readonly string[];
  }): Promise<ProviderGroupRemotePick>;
  cool(ownerDeviceId: string, input: {
    providerId: string;
    memberKey: string;
    cause: ProviderGroupRemoteCoolCause;
    resetAt?: number | null;
  }): Promise<void>;
  leases(ownerDeviceId: string, seq: number, entries: readonly ProviderGroupRemoteLease[]): Promise<void>;
  view(ownerDeviceId: string, providerId: string): Promise<ProviderGroupView>;
}

/** 组所在电脑没有这个通道(旧版本)：当作没有组。 */
export class ProviderGroupRemoteUnsupportedError extends Error {
  constructor() {
    super('[UNSUPPORTED_CAPABILITY] the computer with the provider group does not support it');
    this.name = 'ProviderGroupRemoteUnsupportedError';
  }
}

export function createProviderGroupRemoteClient(invoke: ProviderGroupRemoteInvoke): ProviderGroupRemoteClient {
  async function call(ownerDeviceId: string, request: Record<string, unknown>): Promise<unknown> {
    const result = await invoke(ownerDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request]);
    if (result.ok) return result.result;
    if (result.error?.code === 'CHANNEL_NOT_ALLOWED') throw new ProviderGroupRemoteUnsupportedError();
    const message = result.error?.message ?? 'provider group request failed';
    throw Object.assign(new Error(/^\[[A-Z_]+\]/.test(message) ? message : `[REMOTE_AGENT_UNAVAILABLE] ${message}`), {
      code: result.error?.code,
    });
  }

  return {
    async pick(ownerDeviceId, input) {
      try {
        const raw = await call(ownerDeviceId, {
          action: 'pick',
          sessionId: input.sessionId,
          providerId: input.providerId,
          agentKind: input.agentKind,
          model: input.model,
          exclude: [...input.exclude],
        });
        return parseProviderGroupRemotePick(raw, input.providerId);
      } catch (error) {
        if (error instanceof ProviderGroupRemoteUnsupportedError) return { kind: 'none' };
        throw error;
      }
    },

    async cool(ownerDeviceId, input) {
      await call(ownerDeviceId, {
        action: 'cool',
        providerId: input.providerId,
        memberKey: input.memberKey,
        cause: input.cause,
        ...(typeof input.resetAt === 'number' ? { resetAt: input.resetAt } : {}),
      });
    },

    async leases(ownerDeviceId, seq, entries) {
      await call(ownerDeviceId, { action: 'leases', seq, entries: entries.map((e) => ({ ...e })) });
    },

    async view(ownerDeviceId, providerId) {
      return parseProviderGroupRemoteView(await call(ownerDeviceId, { action: 'view', providerId }), providerId);
    },
  };
}
