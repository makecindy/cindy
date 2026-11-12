/**
 * Remote Agent-Net switch (docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」, owner-approved
 * 2026-11-12): a computer on the same account asks another computer whether it can turn Agent-Net on,
 * then asks it to turn its own 「Agent-Net (Beta)」 switch on or off.
 *
 * - `status` is read-only. Older Desktops do not list the channel → CHANNEL_NOT_ALLOWED, which the
 *   requester shows as "needs a Cindy update" instead of guessing from version numbers.
 * - `set` answers first and switches shortly after, because switching restarts the connection that
 *   carries the answer. Turning Agent-Net on arms a dead-man timer on the target: unless the same
 *   requester confirms over an end-to-end encrypted (Agent-Net) link before the deadline, the target
 *   goes back to its previous setting by itself. Turning it off needs no confirmation.
 * - `confirm` only succeeds for the pending switch of the same requester and only over Agent-Net.
 * - 「仅使用 Agent-Net」 is never changed remotely. While it is active, remote disabling is refused;
 *   the person at the target must release that choice there first (owner decision 2026-11-12).
 *
 * The channel carries no new frame, capability bit or relay behaviour; relays (official and self-hosted)
 * forward it like any other invoke. Same-account only: shared-task guests and provider-share guests are
 * refused by the target's dispatch.
 */
export const AGENT_NET_SWITCH_CHANNEL = 'device-link:agent-net-switch:v1';
export const AGENT_NET_SWITCH_VERSION = 1;
/** Reading readiness and recording the request are local and quick; the reply leaves before switching. */
export const AGENT_NET_SWITCH_TIMEOUT_MS = 15_000;
/** Time the target waits for a confirmation over Agent-Net before going back on its own. */
export const AGENT_NET_SWITCH_CONFIRM_MS = 60_000;

export type AgentNetSwitchRequest =
  | { action: 'status' }
  | { action: 'set'; enabled: boolean; switchId: string }
  | { action: 'confirm'; switchId: string };

/** Why the target cannot enable Agent-Net right now; disabling also respects onlyEncrypted. */
export type AgentNetSwitchBlock = 'NOT_SIGNED_IN' | 'SECURE_STORAGE_UNAVAILABLE' | 'RELAY_IDENTITY_MISSING';
/** A saved local choice or a relay with no Device Link route. Optional on older targets. */
export type AgentNetSwitchDisableBlock = 'ENCRYPTION_REQUIRED' | 'V2_ONLY_RELAY';

export interface AgentNetSwitchStatus {
  version: number;
  enabled: boolean;
  onlyEncrypted: boolean;
  disableBlocked?: AgentNetSwitchDisableBlock | null;
  blocked: AgentNetSwitchBlock | null;
  /** A remote switch on this target is waiting for its confirmation. */
  pending: boolean;
  /** 实际到请求电脑的链路；旧端可能不提供，不能从 enabled 推断。 */
  encrypted?: boolean;
}

export interface AgentNetSwitchAccepted {
  version: number;
  switchId: string;
  enabled: boolean;
  /** Milliseconds the target waits for `confirm`; null when no confirmation is needed (off / unchanged). */
  confirmWithinMs: number | null;
}

export interface AgentNetSwitchConfirmed {
  version: number;
  switchId: string;
  confirmed: true;
}

/** Error codes carried in `[CODE]` of an IPC_ERROR message. */
export type AgentNetSwitchErrorCode =
  | 'AGENT_NET_SWITCH_INVALID'
  | 'AGENT_NET_SWITCH_NOT_READY'
  | 'AGENT_NET_SWITCH_ENCRYPTION_REQUIRED'
  | 'AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED'
  | 'AGENT_NET_SWITCH_V2_ONLY_RELAY'
  | 'AGENT_NET_SWITCH_BUSY'
  | 'AGENT_NET_SWITCH_STALE'
  | 'AGENT_NET_SWITCH_NOT_ON_AGENT_NET'
  | 'AGENT_NET_SWITCH_UNAVAILABLE';

const SWITCH_ID = /^[A-Za-z0-9_-]{8,64}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseAgentNetSwitchRequest(value: unknown): AgentNetSwitchRequest | null {
  const root = record(value);
  if (!root) return null;
  if (root.action === 'status') return { action: 'status' };
  const switchId = typeof root.switchId === 'string' && SWITCH_ID.test(root.switchId) ? root.switchId : null;
  if (!switchId) return null;
  if (root.action === 'set' && typeof root.enabled === 'boolean') return { action: 'set', enabled: root.enabled, switchId };
  if (root.action === 'confirm') return { action: 'confirm', switchId };
  return null;
}

/** Field-tolerant: unknown fields are ignored, an unknown block reason is kept as "blocked" generically. */
export function parseAgentNetSwitchStatus(value: unknown): AgentNetSwitchStatus | null {
  const root = record(value);
  if (!root || typeof root.enabled !== 'boolean') return null;
  const blocked = root.blocked === 'NOT_SIGNED_IN' || root.blocked === 'SECURE_STORAGE_UNAVAILABLE' || root.blocked === 'RELAY_IDENTITY_MISSING'
    ? root.blocked
    : root.blocked === null || root.blocked === undefined ? null : 'SECURE_STORAGE_UNAVAILABLE';
  return {
    version: typeof root.version === 'number' ? root.version : AGENT_NET_SWITCH_VERSION,
    enabled: root.enabled,
    onlyEncrypted: root.onlyEncrypted === true,
    ...(root.disableBlocked === 'V2_ONLY_RELAY' || root.disableBlocked === 'ENCRYPTION_REQUIRED'
      ? { disableBlocked: root.disableBlocked } : {}),
    blocked,
    pending: root.pending === true,
    ...(typeof root.encrypted === 'boolean' ? { encrypted: root.encrypted } : {}),
  };
}

export function parseAgentNetSwitchAccepted(value: unknown): AgentNetSwitchAccepted | null {
  const root = record(value);
  if (!root || typeof root.switchId !== 'string' || typeof root.enabled !== 'boolean') return null;
  const within = root.confirmWithinMs;
  return {
    version: typeof root.version === 'number' ? root.version : AGENT_NET_SWITCH_VERSION,
    switchId: root.switchId,
    enabled: root.enabled,
    confirmWithinMs: typeof within === 'number' && Number.isFinite(within) && within > 0 ? within : null,
  };
}

/** Reads `[AGENT_NET_SWITCH_*]` out of an IPC error message; null for anything else. */
export function agentNetSwitchErrorCode(message: unknown): AgentNetSwitchErrorCode | null {
  const match = typeof message === 'string' ? /\[(AGENT_NET_SWITCH_[A-Z_]+)\]/.exec(message) : null;
  return (match?.[1] as AgentNetSwitchErrorCode | undefined) ?? null;
}
