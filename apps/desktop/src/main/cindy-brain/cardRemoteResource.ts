import { GHOST_CARD_ACTION_ID_RE, isGhostCardLinkAllowed } from '../../shared/ghost.js';
import type { GhostCardRow } from './cardService.js';
import { createHash } from 'node:crypto';
import { REMOTE_RESOURCE_CHANGED_CHANNEL, type RemoteResourceBlock } from '@cindy/device-link';
import { managedToolMediaKind } from '@cindy/maker-shared/payload-summary';
import { getGhostCard, upsertGhostCard, type GhostCardRecord } from './cardStoreDb.js';
import { assertRemoteBotInvocationAllowed } from '../device-link/remoteBotSessionBoundary.js';
import { remoteResourceRegistry, RemoteResourceRegistryError, type RemoteResourceProvider } from '../device-link/remoteResourceRegistry.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast, getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';

const COLLECTION = 'plugin-results';
const KIND = 'card';

function decodeText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : full;
  });
}

/** Project persisted, sanitized cards into inert text and managed media. No HTML,
 * CSS, script, action IDs or host bridge crosses the remote resource boundary. */
export function projectGhostCardBlocks(html: string): RemoteResourceBlock[] {
  // Stored cards have already passed sanitizeGhostCardHtml. Re-sanitizing would
  // escape text entities a second time. This projection never interprets HTML.
  const source = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const blocks: RemoteResourceBlock[] = [];
  const urls = new Set<string>();
  for (const match of source.matchAll(/(?:src|data-ghost-audio|data-ghost-model)="(cindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+)"/g)) urls.add(match[1]);
  const text = decodeText(source.replace(/<[^>]+>/g, (tag) => {
    // Keep destinations and image descriptions readable without an executable link.
    const link = / data-ghost-link="([^"]*)"/.exec(tag)?.[1];
    const alt = /^<img\b/i.test(tag) ? / alt="([^"]*)"/.exec(tag)?.[1] : undefined;
    if (link) return ` ${link} `;
    if (alt) return ` ${alt} `;
    return /^(?:<br\b|<hr\b|<\/(?:p|div|h[1-4]|li|tr|section|header|footer|blockquote|pre)\b)/i.test(tag) ? '\n' : /^<\/(?:td|th)\b/i.test(tag) ? '\t' : '';
  }))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text) blocks.push({ id: 'text', primitive: 'markdown', fallbackMarkdown: text.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&') });
  for (const url of urls) {
    const kind = managedToolMediaKind(url) ?? (/\.glb$/.test(url) ? 'file' : null);
    if (kind) blocks.push({ id: `asset-${blocks.length}`, primitive: kind, fallbackMarkdown: url, data: { url } });
  }
  return blocks;
}

export interface RemotePluginCardAction {
  id: string; label: string; prompt?: string; url?: string; disabled: boolean;
}
/** Input is already sanitizer-owned HTML. Only declared inert controls are projected. */
export function projectGhostCardActions(html: string, externalLinks: boolean): RemotePluginCardAction[] {
  const source = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const items: RemotePluginCardAction[] = [];
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const attrs = match[2];
    const read = (name: string) => { const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1]; return value === undefined ? undefined : decodeText(value); };
    const action = read('data-ghost-action'), url = read('data-ghost-link');
    if (!(action && GHOST_CARD_ACTION_ID_RE.test(action)) && !(externalLinks && url && isGhostCardLinkAllowed(url))) continue;
    const after = source.slice(match.index! + match[0].length);
    const label = read('aria-label') ?? decodeText(after.slice(0, after.indexOf(`</${match[1]}>`) < 0 ? 256 : after.indexOf(`</${match[1]}>`)).replace(/<[^>]+>/g, '')).trim().slice(0, 512);
    items.push({ id: action ?? `link:${items.length}`, label: label || action || url!,
      ...(action && read('data-ghost-prompt') !== undefined ? { prompt: read('data-ghost-prompt') } : {}),
      ...(!action && url ? { url } : {}), disabled: /(?:^|\s)disabled(?:\s|$|=)/.test(attrs) });
    if (items.length >= 64) break;
  }
  return items;
}
interface CardInteractions {
  externalLinks(ghostId: string): boolean;
  dispatch(callId: string, actionId: string, prompt: string | undefined, pageId: string, ghostId: string, controllerId: string): Promise<boolean>;
}
/** Task-scoped native controls. No plugin scripts or arbitrary host bridge. */
export function createGhostCardRemoteProvider(deps: {
  readCard: (callId: string) => Promise<GhostCardRecord | null>;
  authorize: (sessionId: string) => Promise<void>;
  captureScope: () => () => boolean;
  interactions?: CardInteractions;
}): RemoteResourceProvider {
  const read = async (id: string) => {
    const valid = deps.captureScope();
    let ids: unknown;
    try { ids = JSON.parse(id); } catch { /* rejected below */ }
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every(value => typeof value === 'string' && value.length > 0 && value.length <= 128))
      throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
    const [sessionId, callId] = ids as [string, string];
    await deps.authorize(sessionId);
    const card = await deps.readCard(callId);
    if (!card || card.sessionId !== sessionId || !valid()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
    await deps.authorize(sessionId);
    if (!valid()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
    return { card, callId, valid, revision: createHash('sha256').update(card.html).digest('hex') };
  };
  return {
    collection: { id: COLLECTION, resourceKind: KIND, title: 'Plugin results' },
    async list() { return { collectionId: COLLECTION, revision: '1', items: [] }; },
    async get(_context, request) {
      const { card, revision } = await read(request.ref.id);
      const blocks = projectGhostCardBlocks(card.html);
      if (deps.interactions && request.client.primitives.includes('plugin-card-actions')) blocks.push({
        id: 'actions', primitive: 'plugin-card-actions', fallbackMarkdown: '',
        data: { pluginId: card.ghostId, revision, items: projectGhostCardActions(card.html, deps.interactions.externalLinks(card.ghostId)) },
      });
      return { ref: request.ref, display: { title: card.ghostId }, links: [], revision, blocks };
    },
    async invoke(context, request) {
      if (!deps.interactions || !request.resourceRef) throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Card actions unavailable');
      const { card, callId, valid, revision } = await read(request.resourceRef.id);
      const action = projectGhostCardActions(card.html, false).find(item => item.id === request.actionId && !item.url);
      const input = request.input ?? {};
      if (!action || action.disabled || input.revision !== revision || typeof input.pageId !== 'string'
        || (action.prompt !== undefined && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000))
        || (action.prompt === undefined && input.prompt !== undefined) || !valid())
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Card action is no longer available');
      const delivered = await deps.interactions.dispatch(callId, action.id, input.prompt as string | undefined, input.pageId, card.ghostId, context.controllerDeviceId);
      if (!valid() || !delivered) throw new RemoteResourceRegistryError('INTERNAL', 'Card action could not be delivered');
      return { effects: [] };
    },
  };
}

let registered = false;
export function registerGhostCardRemoteProvider(readIdentity: (id: string) => { name: string; iconDataUrl?: string } | undefined, interactions?: CardInteractions): void {
  if (registered) return;
  remoteResourceRegistry.register(createGhostCardRemoteProvider({
    readCard: getGhostCard,
    interactions,
    authorize: (sessionId) => assertRemoteBotInvocationAllowed([sessionId]),
    captureScope: () => { const scope = captureDataOwnerBroadcastScope(); return () => isDataOwnerBroadcastScopeCurrent(scope); },
  }));
  remoteResourceRegistry.register(createPluginIdentityRemoteProvider({
    readIdentity,
    authorize: (sessionId) => assertRemoteBotInvocationAllowed([sessionId]),
    captureScope: () => { const scope = captureDataOwnerBroadcastScope(); return () => isDataOwnerBroadcastScopeCurrent(scope); },
  }));
  registered = true;
}

export function notifyGhostCardRemoteChanged(sessionId: string | null, callId: string): void {
  if (!sessionId) return;
  tapWindowBroadcast(REMOTE_RESOURCE_CHANGED_CHANNEL, {
    sessionId,
    collectionId: COLLECTION,
    resourceRefs: [{ collectionId: COLLECTION, kind: KIND, id: JSON.stringify([sessionId, callId]) }],
  }, getSafeDataOwnerPushStamp());
}

/** Invalidate only after the new version is readable, and retain the write's owner. */
export async function persistGhostCardWithRemoteChange(row: GhostCardRow): Promise<void> {
  const scope = captureDataOwnerBroadcastScope();
  await upsertGhostCard(row);
  if (isDataOwnerBroadcastScopeCurrent(scope)) notifyGhostCardRemoteChanged(row.sessionId, row.callId);
}


/** Public identity only; never exposes the installed manifest, credentials or local paths. */
export function createPluginIdentityRemoteProvider(deps: {
  readIdentity: (id: string) => { name: string; iconDataUrl?: string } | undefined;
  authorize: (sessionId: string) => Promise<void>;
  captureScope: () => () => boolean;
}): RemoteResourceProvider {
  const collectionId = 'plugin-identities';
  return {
    collection: { id: collectionId, resourceKind: 'plugin', title: 'Plugins' },
    async list() { return { collectionId, revision: '1', items: [] }; },
    async get(_context, request) {
      const valid = deps.captureScope();
      let ids: unknown;
      try { ids = JSON.parse(request.ref.id); } catch { /* validated below */ }
      if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Plugin not found');
      }
      await deps.authorize(ids[0]);
      if (!valid()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Plugin not found');
      const identity = deps.readIdentity(ids[1]);
      if (!identity) throw new RemoteResourceRegistryError('NOT_FOUND', 'Plugin not found');
      const icon = identity.iconDataUrl;
      const blocks: RemoteResourceBlock[] = icon && icon.length <= 256_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)
        ? [{ id: 'icon', primitive: 'image', fallbackMarkdown: '', data: { url: icon } }] : [];
      return { ref: request.ref, display: { title: identity.name }, links: [], blocks,
        revision: createHash('sha256').update(JSON.stringify([identity.name, blocks])).digest('hex') };
    },
  };
}
