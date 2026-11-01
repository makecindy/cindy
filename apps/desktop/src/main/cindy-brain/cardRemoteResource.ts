import { GHOST_CARD_ACTION_ID_RE, isGhostCardLinkAllowed } from '../../shared/ghost.js';
import { readMailCard, isLegacyMailCard, readGhostCardFormChange, readGhostCardForm, parseGhostCardFormValues, omitGhostCardFormPreview } from '@cindy/maker-shared/ghost-card-form';
import type { GhostCardRow } from './cardService.js';
import { createHash } from 'node:crypto';
import { REMOTE_RESOURCE_CHANGED_CHANNEL, type RemoteResourceBlock } from '@cindy/device-link';
import { managedToolMediaKind } from '@cindy/maker-shared/payload-summary';
import type { PrStatusResult } from '@cindy/maker-shared';
import { getGhostCard, upsertGhostCard, type GhostCardRecord } from './cardStoreDb.js';
import { assertRemoteBotInvocationAllowed } from '../device-link/remoteBotSessionBoundary.js';
import { remoteResourceRegistry, RemoteResourceRegistryError, type RemoteResourceProvider } from '../device-link/remoteResourceRegistry.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast, getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { isValidGhostId } from '../../shared/ghost.js';
import { createPluginLogicalIdentity, findInstalledGhostByIdentity, findInstalledGhostByInstanceId, isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { parseMailAttachmentUpload, type MailAttachmentUpload } from './mailAttachmentUpload.js';

const COLLECTION = 'plugin-results';
const KIND = 'card';

export function findGhostForRemotePluginIdentity<T extends { manifest: { id: string }; namespace?: string | null }>(
  ghosts: readonly T[], id: string,
): T | undefined {
  if (isGhostInstanceId(id) && !isValidGhostId(id)) {
    return findInstalledGhostByInstanceId(ghosts, id);
  }
  if (!id.startsWith('[')) {
    const matches = ghosts.filter((ghost) => ghost.manifest.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        (parsed[0] !== null && typeof parsed[0] !== 'string') || !isValidGhostId(parsed[1])) return undefined;
    return findInstalledGhostByIdentity(ghosts, createPluginLogicalIdentity(parsed[0], parsed[1]));
  } catch {
    return undefined;
  }
}

function decodeText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : full;
  });
}

/** Sanitized card HTML to plain text: block ends become line breaks. */
function cardText(html: string, inlineLinks: boolean): string {
  return decodeText(html.replace(/<[^>]+>/g, (tag) => {
    // Keep destinations and image descriptions readable without an executable link. When the
    // plugin may open links, the phone gets the link as its own control, so the text keeps only
    // the link's words instead of a raw address in front of them.
    const link = / data-ghost-link="([^"]*)"/.exec(tag)?.[1];
    const alt = /^<img\b/i.test(tag) ? / alt="([^"]*)"/.exec(tag)?.[1] : undefined;
    if (link) return inlineLinks && isGhostCardLinkAllowed(decodeText(link)) ? '' : ` ${link} `;
    if (alt) return ` ${alt} `;
    return /^(?:<br\b|<hr\b|<\/(?:p|div|h[1-4]|li|tr|section|header|footer|blockquote|pre)\b)/i.test(tag) ? '\n' : /^<\/(?:td|th)\b/i.test(tag) ? '\t' : '';
  }))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripStyleAndScript(html: string): string {
  return html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

/** Project persisted, sanitized cards into inert text and managed media. No HTML,
 * CSS, script, action IDs or host bridge crosses the remote resource boundary. */
export function projectGhostCardBlocks(html: string, options: { inlineLinks?: boolean } = {}): RemoteResourceBlock[] {
  // Stored cards have already passed sanitizeGhostCardHtml. Re-sanitizing would
  // escape text entities a second time. This projection never interprets HTML.
  const source = stripStyleAndScript(html);
  const blocks: RemoteResourceBlock[] = [];
  const urls = new Set<string>();
  for (const match of source.matchAll(/(?:src|data-ghost-audio|data-ghost-model)="(cindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+)"/g)) urls.add(match[1]);
  const text = cardText(source, options.inlineLinks === true);
  if (text) blocks.push({ id: 'text', primitive: 'markdown', fallbackMarkdown: text.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&') });
  for (const url of urls) {
    const kind = managedToolMediaKind(url) ?? (/\.glb$/.test(url) ? 'file' : null);
    if (kind) blocks.push({ id: `asset-${blocks.length}`, primitive: kind, fallbackMarkdown: url, data: { url } });
  }
  return blocks;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track']);

/** Top-level elements whose opening tag matches `marker`. Sanitized HTML is balanced. */
function markedElements(html: string, marker: RegExp): Array<{ attrs: string; start: number; innerStart: number; innerEnd: number; end: number }> {
  const found: Array<{ attrs: string; start: number; innerStart: number; innerEnd: number; end: number }> = [];
  const tags = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (let open = tags.exec(html); open; open = tags.exec(html)) {
    const name = open[2].toLowerCase();
    if (open[1] || VOID_TAGS.has(name) || !marker.test(open[3])) continue;
    const innerStart = tags.lastIndex;
    let depth = 1;
    for (let next = tags.exec(html); next; next = tags.exec(html)) {
      if (next[2].toLowerCase() !== name) continue;
      depth += next[1] ? -1 : 1;
      if (depth === 0) {
        found.push({ attrs: open[3], start: open.index, innerStart, innerEnd: next.index, end: tags.lastIndex });
        break;
      }
    }
  }
  return found;
}

function readAttr(attrs: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
  return value === undefined ? undefined : decodeText(value);
}

function cardLines(fragment: string): string[] {
  return cardText(fragment, true).split('\n').map((line) => line.trim()).filter(Boolean);
}

export interface RichCardParts {
  /** Card HTML with the structured parts' contents removed, for the text block. */
  textHtml: string;
  toggles: Map<string, { title: string; hint?: string }>;
  live?: string;
  prStatus: Array<{ key: string; fallback: string[] }>;
}

/**
 * Parts newer phones draw natively (they ask for the `plugin-card-rich` primitive): setting
 * switches, a live indicator, and PR status slots. Their text leaves the text block so it is
 * not shown twice; older phones keep the plain projection.
 */
export function projectRichCardParts(html: string): RichCardParts {
  const source = stripStyleAndScript(html);
  const cuts: Array<[number, number]> = [];
  const toggles = new Map<string, { title: string; hint?: string }>();
  for (const el of markedElements(source, /(?:^|\s)data-ghost-toggle="(?:on|off)"/)) {
    const action = readAttr(el.attrs, 'data-ghost-action');
    const [title, ...rest] = cardLines(source.slice(el.innerStart, el.innerEnd));
    if (action && title) toggles.set(action, { title: title.slice(0, 120), ...(rest.length ? { hint: rest.join(' ').slice(0, 240) } : {}) });
    cuts.push([el.innerStart, el.innerEnd]);
  }
  let live: string | undefined;
  for (const el of markedElements(source, /(?:^|\s)data-ghost-live-label="[^"]+"/)) {
    live ??= readAttr(el.attrs, 'data-ghost-live-label')?.slice(0, 64);
    cuts.push([el.innerStart, el.innerEnd]);
  }
  const prStatus: Array<{ key: string; fallback: string[] }> = [];
  for (const el of markedElements(source, /(?:^|\s)data-ghost-pr-status="[^"]+"/)) {
    const value = readAttr(el.attrs, 'data-ghost-pr-status') ?? '';
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
    if (m) prStatus.push({ key: `${m[1].toLowerCase()}/${m[2].toLowerCase()}#${Number(m[3])}`, fallback: cardLines(source.slice(el.innerStart, el.innerEnd)).slice(0, 8) });
    cuts.push([el.innerStart, el.innerEnd]);
  }
  cuts.sort((a, b) => b[0] - a[0]);
  let textHtml = source;
  for (const [from, to] of cuts) textHtml = textHtml.slice(0, from) + textHtml.slice(to);
  return { textHtml, toggles, ...(live ? { live } : {}), prStatus: prStatus.slice(0, 4) };
}

export interface RemotePluginCardAction {
  id: string; label: string; prompt?: string; url?: string; disabled: boolean; submit?: boolean;
  /** Phone hints (only for `plugin-card-rich` clients). */
  primary?: true;
  toggle?: { on: boolean; title: string; hint?: string };
}
/** Input is already sanitizer-owned HTML. Only declared inert controls are projected. */
export function projectGhostCardActions(
  html: string,
  externalLinks: boolean,
  rich?: { toggles: Map<string, { title: string; hint?: string }> },
): RemotePluginCardAction[] {
  const source = stripStyleAndScript(html);
  const items: RemotePluginCardAction[] = [];
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const attrs = match[2];
    const read = (name: string) => readAttr(attrs, name);
    const action = read('data-ghost-action'), url = read('data-ghost-link');
    if (!(action && GHOST_CARD_ACTION_ID_RE.test(action)) && !(externalLinks && url && isGhostCardLinkAllowed(url))) continue;
    const after = source.slice(match.index! + match[0].length);
    const label = read('aria-label') ?? decodeText(after.slice(0, after.indexOf(`</${match[1]}>`) < 0 ? 256 : after.indexOf(`</${match[1]}>`)).replace(/<[^>]+>/g, '')).trim().slice(0, 512);
    const toggleState = read('data-ghost-toggle');
    const toggle = rich && action && (toggleState === 'on' || toggleState === 'off') ? rich.toggles.get(action) : undefined;
    items.push({ id: action ?? `link:${items.length}`, label: label || action || url!,
      ...(read('data-ghost-submit') === 'true' ? { submit: true } : {}),
      ...(action && read('data-ghost-prompt') !== undefined ? { prompt: read('data-ghost-prompt') } : {}),
      ...(!action && url ? { url } : {}), disabled: /(?:^|\s)disabled(?:\s|$|=)/.test(attrs),
      ...(rich && action && read('data-ghost-primary') !== undefined ? { primary: true as const } : {}),
      ...(toggle ? { toggle: { on: toggleState === 'on', ...toggle } } : {}) });
    if (items.length >= 64) break;
  }
  return items;
}
interface CardInteractions {
  externalLinks(ghostId: string): boolean;
  dispatch(callId: string, actionId: string, prompt: string | undefined, pageId: string, ghostId: string, controllerId: string, formValues?: Record<string, string>, formChange?: boolean, upload?: MailAttachmentUpload): Promise<boolean>;
}
function mailUploadAction(html: string): RemotePluginCardAction | undefined {
  const mail = readMailCard(html);
  return mail && !mail.supersededBy && ['draft', 'syncing', 'error'].includes(mail.state) && mail.fields.some(f => f.kind === 'mail-attachments')
    ? { id: `mail:attach:${mail.key}`, label: 'Attach', disabled: false, submit: true } : undefined;
}
/** Task-scoped native controls. No plugin scripts or arbitrary host bridge. */
export function createGhostCardRemoteProvider(deps: {
  readCard: (callId: string) => Promise<GhostCardRecord | null>;
  authorize: (sessionId: string) => Promise<void>;
  captureScope: () => () => boolean;
  interactions?: CardInteractions;
  /** Same session-scoped PR status the task's title bar shows; undefined keeps the plugin's snapshot. */
  prStatus?: (sessionId: string, key: string) => Promise<PrStatusResult | undefined>;
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
      const supportsForms = Boolean(deps.interactions) && request.client.primitives.includes('plugin-card-actions') && request.client.primitives.includes('plugin-card-forms');
      const mail = readMailCard(card.html), legacyMail = isLegacyMailCard(card.html);
      const obsolete = !!mail?.supersededBy || legacyMail;
      const externalLinks = deps.interactions?.externalLinks(card.ghostId) ?? false;
      const rich = Boolean(deps.interactions) && request.client.primitives.includes('plugin-card-actions') && request.client.primitives.includes('plugin-card-rich')
        ? projectRichCardParts(card.html) : undefined;
      const textSource = rich?.textHtml ?? card.html;
      const blocks = supportsForms && (mail || legacyMail) ? [] : projectGhostCardBlocks(supportsForms ? omitGhostCardFormPreview(textSource) : textSource, { inlineLinks: externalLinks });
      const prStatus = rich ? await Promise.all(rich.prStatus.map(async (slot) => {
        const status = await deps.prStatus?.(card.sessionId!, slot.key).catch(() => undefined);
        return { ...slot, ...(status?.ok ? { status } : {}) };
      })) : undefined;
      if (deps.interactions && request.client.primitives.includes('plugin-card-actions')) blocks.push({
        id: 'actions', primitive: 'plugin-card-actions', fallbackMarkdown: '',
        data: { pluginId: card.ghostId, revision, mail, legacyMail, mailUpload: supportsForms && !!mailUploadAction(card.html), changeAction: supportsForms && !obsolete ? readGhostCardFormChange(card.html) : undefined, form: supportsForms ? readGhostCardForm(card.html) : null,
          items: obsolete ? [] : projectGhostCardActions(card.html, externalLinks, rich).map(action => action.submit && !supportsForms ? { ...action, disabled: true } : action),
          ...(rich?.live ? { live: rich.live } : {}),
          ...(prStatus?.length ? { prStatus } : {}) },
      });
      return { ref: request.ref, display: { title: card.ghostId }, links: [], revision, blocks };
    },
    async invoke(context, request) {
      if (!deps.interactions || !request.resourceRef) throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Card actions unavailable');
      const { card, callId, valid, revision } = await read(request.resourceRef.id);
      if (isLegacyMailCard(card.html) || readMailCard(card.html)?.supersededBy) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Mail view has been replaced');
      const change = request.input?.formChange === true;
      const uploadAction = !change ? mailUploadAction(card.html) : undefined;
      const attaching = uploadAction?.id === request.actionId;
      const upload = parseMailAttachmentUpload(request.input?.mailAttachment);
      if (attaching ? !upload : request.input?.mailAttachment !== undefined)
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail attachment');
      const action = change && readGhostCardFormChange(card.html) === request.actionId
        ? { id: request.actionId, submit: true, disabled: false, prompt: undefined }
        : change ? undefined : attaching ? uploadAction : projectGhostCardActions(card.html, false).find(item => item.id === request.actionId && !item.url);
      const input = request.input ?? {};
      const form = readGhostCardForm(card.html);
      const values = input.formValues === undefined ? null : parseGhostCardFormValues(input.formValues);
      if (action?.submit ? (!form || !values || Object.keys(values).length !== form.length || form.some(field => !(field.name in values))) : input.formValues !== undefined)
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Card form is unavailable or incomplete');
      if (!action || action.disabled || (!change && input.revision !== revision && !(action?.submit && input.formKey && input.formKey === readGhostCardFormChange(card.html))) || typeof input.pageId !== 'string'
        || (action.prompt !== undefined && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000))
        || (action.prompt === undefined && input.prompt !== undefined) || !valid())
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Card action is no longer available');
      const extra: [boolean?, MailAttachmentUpload?] = upload ? [false, upload] : change ? [true] : [];
      const delivered = await deps.interactions.dispatch(callId, action.id, input.prompt as string | undefined, input.pageId, card.ghostId, context.controllerDeviceId, values ?? undefined, ...extra);
      if (!valid() || !delivered) throw new RemoteResourceRegistryError('INTERNAL', 'Card action could not be delivered');
      return { effects: [] };
    },
  };
}

let registered = false;
export function registerGhostCardRemoteProvider(
  readIdentity: (id: string) => { name: string; iconDataUrl?: string } | undefined,
  interactions?: CardInteractions,
  prStatus?: (sessionId: string, key: string) => Promise<PrStatusResult | undefined>,
): void {
  if (registered) return;
  remoteResourceRegistry.register(createGhostCardRemoteProvider({
    readCard: getGhostCard,
    interactions,
    prStatus,
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
      if (!Array.isArray(ids) || ids.length !== 2 ||
          typeof ids[0] !== 'string' || ids[0].length === 0 || ids[0].length > 128 ||
          typeof ids[1] !== 'string' || ids[1].length === 0 || ids[1].length > 320) {
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
