/**
 * feishu/ownerGuard.ts
 * ---------------------------------------------------------------------------
 * Per-bot-app whitelist of sender open_ids that may p2p-chat with the bot.
 *
 * Source of truth is the encrypted `feishu_bot_owner_open_id` file on disk
 * (via storage.ts → host.secrets); in-memory `allowed` set is a hot cache
 * loaded on `loadFromDisk()` (called by FeishuIM.init / when a TOFU claim
 * succeeds).
 *
 * Owner is set TOFU-style: the first p2p sender becomes owner. After that,
 * the same sender open_id is the only one that can talk to the bot. Reset by
 * clearing all credentials (Settings → trash icon).
 *
 * Why per-bot-app: feishu open_id is per-app, so the user's xdt-server
 * openId (from a different feishu app) cannot be used to whitelist senders
 * for an arbitrary user-supplied bot. TOFU sidesteps this entirely — the
 * owner id we capture comes from the bot's own event stream.
 *
 * Rejected senders are not logged at info-level to avoid leaking sender
 * existence via logs (DoS-style probe). Rejected events return false.
 */

import * as storage from './storage.js';
import { scopeSlot } from './moduleScope.js';

const owner_SLOT = Symbol('feishu.owner');
function createOwnerState() {
  return {
    allowed: new Set() as Set<string>,
  };
}
/** 本实例(FeishuScope)的模块状态; 没有 scope 时落在默认实例上。 */
const S = () => scopeSlot(owner_SLOT, createOwnerState);

/** Re-load from disk into the in-memory set. Idempotent. */
export function loadFromDisk(): void {
  S().allowed = new Set();
  const owner = storage.readOwnerOpenId();
  if (owner) S().allowed.add(owner);
}

export function getAllowed(): ReadonlyArray<string> {
  return Array.from(S().allowed);
}

export function check(senderOpenId: string): boolean {
  return S().allowed.has(senderOpenId);
}

/** First whitelisted open_id, used as the lifecycle-announcement target. */
export function firstAllowed(): string | null {
  const it = S().allowed.values().next();
  return it.done ? null : (it.value as string);
}

/**
 * TOFU claim: if no owner yet, set `senderOpenId` as owner (write-through to
 * disk + cache) and return true (caller should send a welcome message).
 * Otherwise return false (no-op).
 */
export function tryClaimOwner(senderOpenId: string): boolean {
  if (S().allowed.size > 0) return false;
  const ok = storage.writeOwnerOpenId(senderOpenId);
  if (!ok) return false;
  S().allowed.add(senderOpenId);
  return true;
}

/** Manual reset (e.g. on credentials clear). Wipes both disk and cache. */
export function clear(): void {
  storage.clearOwnerOpenId();
  S().allowed = new Set();
}
