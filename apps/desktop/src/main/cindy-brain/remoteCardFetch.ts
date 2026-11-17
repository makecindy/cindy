/**
 * A plugin card of a task that runs on another computer, as this desktop shows it.
 *
 * The card lives on the task's computer. Hosts that understand `plugin-card-html` return the
 * stored markup in the existing `plugin-results` actions block; this computer sanitizes it again
 * before it reaches the renderer, so a remote host never widens what a card may contain here.
 * Older hosts omit the markup and the task keeps its plain tool rows.
 */
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { isLegacyMailCard, readMailCard } from '@cindy/maker-shared/ghost-card-form';
import { GHOST_CARD_HEIGHT_MAX, GHOST_CARD_HEIGHT_MIN, isValidGhostId } from '../../shared/ghost.js';
import { isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { PLUGIN_CARD_HTML_PRIMITIVE } from './cardRemoteResource.js';
import { sanitizeGhostCardHtml } from './cardSanitizer.js';

export const REMOTE_CARD_PRIMITIVES = ['plugin-card-actions', 'plugin-card-forms', PLUGIN_CARD_HTML_PRIMITIVE];

export interface RemoteGhostCard {
  ghostId: string;
  html: string;
  height: number;
  /** Echoed with an action so the host can tell the click was made on this version. */
  revision: string;
  /** The plugin may open links from its card, as decided on the task's computer. */
  externalLinks: boolean;
}

type Invoke = (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;

const ID_MAX = 128;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;

/**
 * `card: null` means this card cannot be shown here: none exists, it is a mail card, or its markup
 * failed this computer's sanitizer. `unsupported` marks a host that ignored `plugin-card-html`
 * (an older version), so the controller can stop asking it for the rest of the task.
 */
export async function fetchRemoteGhostCard(
  invoke: Invoke, deviceId: unknown, sessionId: unknown, callId: unknown,
): Promise<{ card: RemoteGhostCard } | { card: null; unsupported?: true; failed?: true }> {
  if (!isId(deviceId) || !isId(sessionId) || !isId(callId)) return { card: null };
  const raw = await invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
    client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: REMOTE_CARD_PRIMITIVES },
    ref: { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify([sessionId, callId]) },
  }]);
  const reply = raw as { ok?: unknown; result?: { blocks?: unknown } } | null;
  if (reply?.ok !== true) return { card: null, failed: true };
  const blocks = reply.result?.blocks;
  const block = Array.isArray(blocks)
    ? blocks.find((item): item is { primitive: string; data?: unknown } => !!item && typeof item === 'object' && (item as { primitive?: unknown }).primitive === 'plugin-card-actions')
    : undefined;
  const data = block?.data as { pluginId?: unknown; revision?: unknown; card?: unknown; mail?: unknown; legacyMail?: unknown } | undefined;
  if (!data) return { card: null, unsupported: true };
  const card = data.card as { html?: unknown; height?: unknown; externalLinks?: unknown } | undefined;
  if (!card) return data.mail || data.legacyMail ? { card: null } : { card: null, unsupported: true };
  if (typeof card.html !== 'string' || typeof data.revision !== 'string' || data.revision.length > 128) return { card: null };
  const ghostId = data.pluginId;
  if (typeof ghostId !== 'string' || !(isValidGhostId(ghostId) || isGhostInstanceId(ghostId))) return { card: null };
  const sanitized = sanitizeGhostCardHtml(card.html);
  // Mail cards depend on host-only markers that a second pass removes; they keep their projection.
  if (!sanitized.ok || readMailCard(sanitized.html) || isLegacyMailCard(sanitized.html)) return { card: null };
  const height = typeof card.height === 'number' && Number.isFinite(card.height)
    ? Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, Math.round(card.height)))
    : GHOST_CARD_HEIGHT_MIN;
  return { card: { ghostId, html: sanitized.html, height, revision: data.revision, externalLinks: card.externalLinks === true } };
}
