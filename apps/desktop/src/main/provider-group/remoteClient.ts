/**
 * 同账号其他电脑这一侧：经 `provider-group:remote` 问组所在电脑(docs/product-rules/provider-groups.md §4–§6)。
 *
 * 组所在电脑是旧版本(`CHANNEL_NOT_ALLOWED`)或这个供应商已经没有组时，`pick` 返回 `none`，调用方照常
 * 直接在组所在电脑上运行；其他失败原样抛出，由调用方决定(分配阶段按连不上组所在电脑处理)。
 */
import { MAX_FRAME_BYTES, MAX_TRANSPORT_MESSAGE_BYTES, PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import {
  parseProviderGroupRemotePick,
  parseProviderGroupRemoteView,
  providerGroupUsageRowsForWire,
  PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS,
  PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS,
  type ProviderGroupRemoteCoolCause,
  type ProviderGroupRemoteLease,
  type ProviderGroupRemotePick,
  type ProviderGroupRemoteUsageRow,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { PROVIDER_GROUP_FAILURE_COOLDOWN_MS } from './cooling.js';

/** 留出 invoke 路由头的空间，同时适配可靠传输和旧端普通帧；预算按 JSON 的 UTF-8 字节数计。 */
export const PROVIDER_GROUP_USAGE_REQUEST_MAX_BYTES = Math.min(MAX_FRAME_BYTES, MAX_TRANSPORT_MESSAGE_BYTES) - 64 * 1024;

export type ProviderGroupRemoteInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;

export interface ProviderGroupRemoteClient {
  pick(ownerDeviceId: string, input: {
    sessionId: string;
    providerId: string;
    agentKind: 'claude-code' | 'codex' | 'pi' | 'zcode';
    model: string;
    exclude: readonly string[];
    quotaRebalance?: string;
  }): Promise<ProviderGroupRemotePick>;
  cool(ownerDeviceId: string, input: {
    providerId: string;
    memberKey: string;
    cause: ProviderGroupRemoteCoolCause;
    resetAt?: number | null;
    model?: string;
  }): Promise<void>;
  leases(ownerDeviceId: string, seq: number, entries: readonly ProviderGroupRemoteLease[]): Promise<void>;
  view(ownerDeviceId: string, providerId: string, modelOrOptions?: string | { model?: string; agentKind?: 'claude-code' | 'codex' | 'pi' | 'zcode'; includeGuestSupport?: boolean }): Promise<ProviderGroupView>;
  /** 报告经组、在组里别的电脑上运行的用量；组所在电脑是旧版本时抛 ProviderGroupRemoteUnsupportedError。 */
  usage(ownerDeviceId: string, report: { seq: number; sinceDay: string | null; rows: readonly ProviderGroupRemoteUsageRow[] }, beforeSend?: () => void): Promise<void>;
}

/** 组所在电脑没有这个通道(旧版本)：当作没有组。 */
export class ProviderGroupRemoteUnsupportedError extends Error {
  constructor() {
    super('[UNSUPPORTED_CAPABILITY] the computer with the provider group does not support it');
    this.name = 'ProviderGroupRemoteUnsupportedError';
  }
}

/** Start recovery before catalog probes without delaying the owner's group snapshot. */
export function recoverProviderGroupViewShares(
  view: ProviderGroupView,
  recoverShares?: (agentDeviceIds: readonly string[]) => Promise<void>,
): void {
  const usable = new Set(view.members.filter((member) => member.state === 'available' || member.state === 'full').map((member) => member.key));
  const shares = view.config?.members.filter((member) => member.kind === 'share' && usable.has(member.key))
    .flatMap((member) => member.agentDeviceId ? [member.agentDeviceId] : []) ?? [];
  // Catalog resolution waits within the settings page's existing per-member deadline.
  void recoverShares?.(shares).catch(() => undefined);
}

export function createProviderGroupRemoteClient(invoke: ProviderGroupRemoteInvoke, options: {
  /** Capture the account before the request; only verified same-account group responses can restore shares. */
  captureShareRecovery?(): (agentDeviceIds: readonly string[]) => Promise<void>;
} = {}): ProviderGroupRemoteClient {
  async function call(ownerDeviceId: string, request: Record<string, unknown>, preSend?: () => void): Promise<unknown> {
    const result = preSend
      ? await invoke(ownerDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request], { preSend })
      : await invoke(ownerDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request]);
    if (result.ok) return result.result;
    if (result.error?.code === 'CHANNEL_NOT_ALLOWED') throw new ProviderGroupRemoteUnsupportedError();
    const message = result.error?.message ?? 'provider group request failed';
    throw Object.assign(new Error(/^\[[A-Z_]+\]/.test(message) ? message : `[REMOTE_AGENT_UNAVAILABLE] ${message}`), {
      code: result.error?.code,
    });
  }

  return {
    async pick(ownerDeviceId, input) {
      const recoverShares = options.captureShareRecovery?.();
      try {
        const raw = await call(ownerDeviceId, {
          action: 'pick',
          sessionId: input.sessionId,
          providerId: input.providerId,
          agentKind: input.agentKind,
          model: input.model,
          exclude: [...input.exclude],
          ...(input.quotaRebalance ? { quotaRebalance: input.quotaRebalance } : {}),
        });
        // 旧组所在电脑可能忽略这个可选约束：只有明确执行并回显的结果才用于主动换号。
        if (input.quotaRebalance && (!raw || typeof raw !== 'object'
          || (raw as { quotaRebalance?: unknown }).quotaRebalance !== true)) return { kind: 'none' };
        const pick = parseProviderGroupRemotePick(raw, input.providerId);
        if (pick.kind === 'member' && pick.member.kind === 'share' && pick.member.agentDeviceId) {
          await recoverShares?.([pick.member.agentDeviceId]);
        }
        return pick;
      } catch (error) {
        if (error instanceof ProviderGroupRemoteUnsupportedError) return { kind: 'none' };
        throw error;
      }
    },

    async cool(ownerDeviceId, input) {
      const scoped = input.cause === 'usage-limit' && !!input.model;
      const request = {
        action: scoped ? 'cool-model' : 'cool',
        providerId: input.providerId,
        memberKey: input.memberKey,
        cause: input.cause,
        ...(input.model ? { model: input.model } : {}),
        ...(typeof input.resetAt === 'number' ? { resetAt: input.resetAt } : {}),
      };
      try {
        await call(ownerDeviceId, request);
      } catch (error) {
        // Old owners reject unknown actions. A short legacy cooldown must not carry the model's weekly reset.
        if (!scoped || !(error instanceof Error) || !/unknown provider group action/.test(error.message)) throw error;
        await call(ownerDeviceId, { ...request, action: 'cool', model: undefined,
          resetAt: Date.now() + PROVIDER_GROUP_FAILURE_COOLDOWN_MS });
      }
    },

    async leases(ownerDeviceId, seq, entries) {
      await call(ownerDeviceId, { action: 'leases', seq, entries: entries.map((e) => ({ ...e })) });
    },

    async view(ownerDeviceId, providerId, modelOrOptions) {
      const recoverShares = options.captureShareRecovery?.();
      const model = typeof modelOrOptions === 'string' ? modelOrOptions : modelOrOptions?.model;
      const agentKind = typeof modelOrOptions === 'object' ? modelOrOptions?.agentKind : undefined;
      const includeGuestSupport = typeof modelOrOptions === 'object' && modelOrOptions?.includeGuestSupport === true;
      const view = parseProviderGroupRemoteView(await call(ownerDeviceId, {
        action: 'view',
        providerId,
        ...(model ? { model } : {}),
        ...(agentKind ? { agentKind } : {}),
        ...(includeGuestSupport ? { includeGuestSupport: true } : {}),
      }), providerId);
      recoverProviderGroupViewShares(view, recoverShares);
      return view;
    },

    async usage(ownerDeviceId, report, beforeSend) {
      try {
        if (report.rows.length > PROVIDER_GROUP_REMOTE_MAX_USAGE_REPORT_ROWS) {
          throwIpcError('INVALID_PARAMS', 'provider group usage report exceeds ledger limit');
        }
        const rows = providerGroupUsageRowsForWire(report.rows);
        // 每行只序列化一次，包含转义字符的实际开销；避免按字符数低估，也避免反复序列化整批。
        const rowBytes = rows.map((row) => Buffer.byteLength(JSON.stringify(row), 'utf8'));
        const request = { action: 'usage', seq: report.seq, sinceDay: report.sinceDay, rows: [] as unknown[][] };
        const singleBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
          + rowBytes.reduce((total, bytes) => total + bytes, 0) + Math.max(0, rows.length - 1);
        if (rows.length <= PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS && singleBytes <= PROVIDER_GROUP_USAGE_REQUEST_MAX_BYTES) {
          beforeSend?.();
          await call(ownerDeviceId, { ...request, rows }, beforeSend);
          return;
        }
        for (let offset = 0; offset < rows.length;) {
          const request = {
            action: 'usage-part', seq: report.seq, sinceDay: report.sinceDay, offset, total: rows.length, rows: [] as unknown[][],
          };
          let bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
          let end = offset;
          while (end < rows.length && end - offset < PROVIDER_GROUP_REMOTE_MAX_USAGE_ROWS) {
            const added = rowBytes[end]! + (end > offset ? 1 : 0);
            if (bytes + added > PROVIDER_GROUP_USAGE_REQUEST_MAX_BYTES) break;
            bytes += added;
            end++;
          }
          if (end === offset) throwIpcError('INVALID_PARAMS', 'provider group usage row exceeds transport budget');
          beforeSend?.();
          const raw = await call(ownerDeviceId, { ...request, rows: rows.slice(offset, end) }, beforeSend);
          const ack = raw as { seq?: unknown; received?: unknown; committed?: unknown } | null;
          if (!ack || ack.seq !== report.seq || ack.received !== end
            || typeof ack.committed !== 'boolean' || (!ack.committed && end === rows.length)) {
            throwIpcError('PRECONDITION_FAILED', 'provider group usage report part was not acknowledged');
          }
          if (ack.committed) return;
          offset = end;
        }
      } catch (error) {
        // 有组、但还不认识用量报告的旧版本：按不支持处理(调用方之后再试)。
        if (error instanceof Error && /unknown provider group action/.test(error.message)) {
          throw new ProviderGroupRemoteUnsupportedError();
        }
        throw error;
      }
    },
  };
}
