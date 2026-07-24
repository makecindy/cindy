import { BrowserWindow } from 'electron';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';

export { CONTENT_MODERATION_BLOCKED_MESSAGE } from './constants.js';

export const CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL =
  'content-moderation:input-blocked';
export const CONTENT_MODERATION_OUTPUT_BLOCKED_CHANNEL =
  'content-moderation:output-blocked';

export function broadcastModerationInputBlocked(input: {
  sessionId: string;
  item: AgentInputQueuedMessage;
  reason: 'rejected' | 'cancelled';
}): void {
  const files = input.item.files ?? [];
  const payload = {
    sessionId: input.sessionId,
    clientId: input.item.clientId,
    text: input.item.text,
    files,
    reason: input.reason,
  };
  // Device-link drops oversized frames for non-maker:event channels.
  // Strip large blob fields to keep the notification deliverable.
  const compactFiles = files.map(({ base64: _b, textContent: _t, ...rest }) => rest);
  const compactPayload = { ...payload, files: compactFiles };
  tapWindowBroadcast(CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL, compactPayload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL, payload);
  }
}

export function broadcastModerationOutputBlocked(input: {
  sessionId: string;
  turnId: string;
}): void {
  const payload = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: 'blocked',
    i18nKey: 'contentModeration.blocked',
  } as const;
  tapWindowBroadcast(CONTENT_MODERATION_OUTPUT_BLOCKED_CHANNEL, payload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(CONTENT_MODERATION_OUTPUT_BLOCKED_CHANNEL, payload);
  }
}
