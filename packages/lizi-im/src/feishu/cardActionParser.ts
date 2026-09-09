/**
 * feishu/cardActionParser.ts
 * ---------------------------------------------------------------------------
 * Parse a `card.action.trigger(_v1)` event payload into a normalised
 * `IMCardActionEvent`. The button's `value` JSON shape is the contract between
 * cards.ts (which puts business id+payload into `value`) and the orchestrator
 * (which reads them back here).
 *
 * senderId is always the operator's raw open_id here; wsClient additionally
 * resolves group cards to their lane id via the outbound messageId→lane
 * registry (see outbound.resolveCardLane) — callback context carries no thread
 * info, so the registry is the only way to recover the topic lane.
 *
 * Returns null when the payload is malformed or when the sender is not on the
 * whitelist (caller should drop silently).
 */

import { check as inWhitelist } from './ownerGuard.js';
import type { IMCardActionEvent } from '../types.js';

/**
 * SDK callback shape for `card.action.trigger` — the SDK's RequestHandle.parse()
 * flattens `event` into the parent (see node-sdk/lib/index.js L84088-84093),
 * so `operator` / `action` / `context` end up at the TOP level.
 *
 * IMPORTANT: in the v2 card schema (schema:"2.0"), `open_message_id` and
 * `open_chat_id` live under `context.*` — NOT directly at the top like the
 * old v1 callback shape. We accept either location for forward/backward
 * compatibility but v2 (context.*) is the current path.
 */
interface RawCardActionPayload {
  operator?: { open_id?: string };
  /** v1 legacy location. */
  open_message_id?: string;
  /** v1 legacy location. */
  open_chat_id?: string;
  /** v2 location (what feishu actually sends as of 2026-05). */
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
  action?: {
    value?: unknown;
    tag?: string;
  };
}

export interface ParseCardActionInput {
  raw: unknown;
}

export function parseCardAction(input: ParseCardActionInput): IMCardActionEvent | null {
  const data = input.raw as RawCardActionPayload;
  if (!data) return null;

  const senderId = data.operator?.open_id;
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const chatId = data.context?.open_chat_id ?? data.open_chat_id;
  if (!senderId || !messageId || !chatId) return null;

  if (!inWhitelist(senderId)) return null;

  const valueRaw = data.action?.value;
  if (!valueRaw || typeof valueRaw !== 'object') return null;
  const value = valueRaw as Record<string, unknown>;

  const id = typeof value.id === 'string' ? value.id : '';
  if (!id) return null;

  const { id: _id, ...payload } = value;
  void _id; // silence unused

  return {
    channelName: 'feishu',
    senderId,
    chatId,
    messageId,
    buttonId: id,
    payload,
  };
}
