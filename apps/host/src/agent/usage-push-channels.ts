import type { BroadcastTapListener } from '../../../desktop/src/main/device-link/broadcastTapCore.ts';

/**
 * Phase 1: the usage pushes the Host does not forward to remote devices (release table row 13, 3d;
 * §二 "用量变化不推给远程设备"; §七). The desktop's usage cores send these through the device-link tap
 * (tapWindowBroadcast) when they record usage or a quota snapshot; on the desktop a phone or another
 * computer sees them live. The Host's usage reads and pushes are a later batch, so in phase 1 its
 * remote devices see usage only when they read it again.
 *
 * Every `usage:` channel the device-link may forward at all (PUSH_FORWARD_ALLOWLIST) is in exactly one of
 * the two lists below; agent/usage-recording.test.mjs fails on a new one, so it cannot slip through.
 * Channels outside both lists and outside `usage:` are forwarded as on the desktop.
 *
 * Lift: delete PHASE1_UNFORWARDED_USAGE_CHANNELS (and its filter in device-link.ts) when the Host's usage
 * "reads and pushes" batch lands.
 */
export const PHASE1_UNFORWARDED_USAGE_CHANNELS: ReadonlySet<string> = new Set([
  // Turn usage records (usage-recording.ts).
  'usage:session-spend-changed',
  'usage:session-tokens-changed',
  'usage:message-turn-cost',
  'usage:message-model-mismatch',
  // Quota snapshots (usageBroadcasterCore.ts, claudeAccountUsage.ts). The Host binds their refreshes
  // empty in phase 1, but a snapshot another path records would still be sent.
  'usage:xai-rate-limit-changed',
  'usage:xai-provider-rate-limit-changed',
  'usage:codex-account-changed',
  'usage:codex-provider-account-changed',
  'usage:claude-subscription-changed',
  'usage:subscription-provider-account-changed',
  'usage:claude-account-changed',
  'usage:xai-subscription-changed',
]);

/**
 * `usage:` channels of PUSH_FORWARD_ALLOWLIST the Host forwards on purpose, each with its reason. None
 * today. (`usage:session-context-changed`, the context occupancy, is not in PUSH_FORWARD_ALLOWLIST: the tap
 * drops it on the desktop and the Host alike. `usage:today-spend-changed` and `usage:today-tokens-changed`
 * go to windows only, never through the tap.)
 */
export const INTENTIONALLY_FORWARDED_USAGE_CHANNELS: ReadonlyMap<string, string> = new Map();

/** The device-link tap listener with the phase 1 usage channels left out; every other push as given. */
export function withoutPhaseOneUsagePushes(listener: BroadcastTapListener | null): BroadcastTapListener | null {
  if (!listener) return null;
  return (...args: Parameters<BroadcastTapListener>) => {
    if (PHASE1_UNFORWARDED_USAGE_CHANNELS.has(args[0])) return;
    listener(...args);
  };
}
