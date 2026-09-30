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

/** Read only, task-scoped resource; no list of cards or desktop interaction surface. */
export function createGhostCardRemoteProvider(deps: {
  readCard: (callId: string) => Promise<GhostCardRecord | null>;
  authorize: (sessionId: string) => Promise<void>;
  captureScope: () => () => boolean;
}): RemoteResourceProvider {
  return {
    collection: { id: COLLECTION, resourceKind: KIND, title: 'Plugin results' },
    async list() { return { collectionId: COLLECTION, revision: '1', items: [] }; },
    async get(_context, request) {
      const validScope = deps.captureScope();
      let ids: unknown;
      try { ids = JSON.parse(request.ref.id); } catch { /* rejected below */ }
      if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
      }
      const [sessionId, callId] = ids as [string, string];
      await deps.authorize(sessionId);
      const card = await deps.readCard(callId);
      if (!card || card.sessionId !== sessionId || !validScope()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
      await deps.authorize(sessionId);
      if (!validScope()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Card does not exist');
      return {
        ref: request.ref,
        display: { title: card.ghostId },
        links: [],
        revision: createHash('sha256').update(card.html).digest('hex'),
        blocks: projectGhostCardBlocks(card.html),
      };
    },
  };
}

let registered = false;
export function registerGhostCardRemoteProvider(readIdentity: (id: string) => { name: string; iconDataUrl?: string } | undefined): void {
  if (registered) return;
  remoteResourceRegistry.register(createGhostCardRemoteProvider({
    readCard: getGhostCard,
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
