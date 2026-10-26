/**
 * Home-only mirror of a companion's canonical Session into its 1:1 Chat Server room
 * (cloud-companions.md §4): user-visible messages and the companion's replies only,
 * deduplicated by local message id, resumed from a cursor after each successful import.
 */
import { createHash } from 'node:crypto';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';
import { messageSourceSenderFromMeta } from '@cindy/maker-shared/message-source';
import { imChannelDisplayName } from '../../shared/imMessageSource.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, isTransientAttachmentFailure, type CompanionApi, type CompanionLog } from './types.js';

export interface CompanionMirrorRow {
  id: string;
  clientId: string;
  role: string;
  content: string;
  agentMeta: string | null;
  createdAt: number;
}
export interface CompanionMirrorCursor { createdAt: number; id: string }

/** Rows of these inputs already live in the room, or came from it. */
export const COMPANION_DIRECT_CLIENT_PREFIX = 'chat-direct:';
export const COMPANION_HISTORY_CLIENT_PREFIX = 'cloud-history:';
export const COMPANION_BACKFILL_LIMIT = 200;
const BACKFILL_SCAN = 1000;
const PAGE = 200;
const MAX_PAGES = 10;
const BATCH_MESSAGES = 50;
// Chat Server accepts 256 KiB bodies; each message stays within its 64 KiB content limit.
const BATCH_BYTES = 200_000;
const PART_CHARS = 30_000;
const PART_BYTES = 60_000;
const RESCAN_WINDOW_MS = 10 * 60_000;
const RESCAN_LIMIT = 200;
const RECENT_IDS = 400;
/** Owner attachments the mirror uploads at most (larger ones stay a name in the room). */
export const MIRROR_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const parse = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};

function attachmentNames(content: unknown): string[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const names: string[] = [];
  for (const [field, fallback] of [['images', '图片'], ['files', '文件']] as const) {
    const list = (content as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const name = [record.originalName, record.name].find((value): value is string => typeof value === 'string' && !!value.trim());
      names.push((name ?? fallback).replace(/[\r\n]+/g, ' ').slice(0, 200));
    }
  }
  return names;
}

/**
 * User rows the companion's own chat hides (automatic continuations, coordination between
 * teammates): not part of the visible conversation, so not in the room either.
 */
const HIDDEN_INPUT_KEYS = ['botTaskCoordination', 'autoResume'] as const;

const SCHEDULER_LABEL = '定时任务';

/**
 * Where a visible user row came from when the owner did not type it here, in the words the chat
 * shows next to it (message-source.md): the room shows the same conversation as the chat, with the
 * same attribution. Owner input (also from another device; `autoReviewUserText` marks it) has none.
 */
export function mirrorSourceLabel(meta: Record<string, unknown>): string | null {
  const sender = messageSourceSenderFromMeta(meta);
  const quote = (name: unknown) => (typeof name === 'string' && name.trim() ? `「${name.trim().slice(0, 80)}」` : '');
  if (sender?.kind === 'plugin') return `来自插件${quote(sender.name)}`;
  if (sender?.kind === 'session') return sender.botId ? `来自伙伴${quote(sender.botName)}` : `来自任务${quote(sender.title)}`;
  if (sender?.kind === 'shared-member') return `来自共享任务成员${quote(sender.name)}`;
  const origin = meta.origin && typeof meta.origin === 'object' ? meta.origin as Record<string, unknown> : null;
  if (origin?.kind === 'scheduler') return `来自${SCHEDULER_LABEL}`;
  if (origin?.kind === 'orca') return '来自协同任务';
  for (const key of ['imSource', 'hookSource'] as const) {
    const source = meta[key] && typeof meta[key] === 'object' ? meta[key] as Record<string, unknown> : null;
    if (source) return `来自${imChannelDisplayName(source.im) ?? '外部渠道'}`;
  }
  if (meta.sourceGroup) return '来自群聊';
  return null;
}

/** A file the owner sent with a message, as the room media upload reads it. */
export interface CompanionMirrorAttachment {
  id: string; name: string; category: 'image' | 'file'; mimeType: string; size: number; url: string | null; path: string | null;
}

/**
 * The owner's attachments of a mirrored user row (images from the media store, files by path on
 * this computer). Only rows that are part of the visible conversation have any.
 */
export function mirrorAttachments(row: CompanionMirrorRow): CompanionMirrorAttachment[] {
  if (row.role !== 'user' || mirrorMessageText(row) === null) return [];
  const content = parse(row.content);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const record = content as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value : []).map(item => (item && typeof item === 'object' ? item as Record<string, unknown> : {}));
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const name = (item: Record<string, unknown>, fallback: string) =>
    ([item.originalName, item.name].find((value): value is string => typeof value === 'string' && !!value.trim()) ?? fallback).replace(/[\r\n]+/g, ' ').slice(0, 200);
  return [
    ...list(record.images).map((item, index) => ({ id: `${row.id}:image:${index}`, name: name(item, '图片'), category: 'image' as const,
      mimeType: text(item.mimeType) || 'image/png', size: typeof item.size === 'number' ? item.size : 0, url: text(item.url) || null, path: null })),
    ...list(record.files).map((item, index) => ({ id: `${row.id}:file:${index}`, name: name(item, '文件'), category: 'file' as const,
      mimeType: text(item.mimeType) || 'application/octet-stream', size: typeof item.size === 'number' ? item.size : 0, url: null, path: text(item.path) || null })),
  ].filter(attachment => attachment.url || attachment.path);
}

/** Room text of a canonical row, or null when the row is not part of the visible conversation. */
export function mirrorMessageText(row: CompanionMirrorRow, options: { placeholders?: boolean } = {}): string | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  if (row.clientId.startsWith(COMPANION_DIRECT_CLIENT_PREFIX) || row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)) return null;
  const parsedMeta = parse(row.agentMeta);
  const meta = parsedMeta && typeof parsedMeta === 'object' ? parsedMeta as Record<string, unknown> : {};
  // Private/coordination replies are hidden in the local timeline as well; so are progress
  // commentary and sub-agent output, which are never a reply (bots.ts canonicalReplyVisibility).
  if (row.role === 'assistant' && (meta.botPrivateReply === true || meta.assistantPhase === 'commentary'
    || (meta.parentToolUseId ?? null) !== null || (meta.parent_tool_use_id ?? null) !== null
    // Claude sub-agent rows; same predicate as the renderer (a legacy transcript link is not one).
    || (typeof meta.parentUuid === 'string' && !!meta.parentUuid && isSubagentParentToolUseId(meta.parentUuid)))) return null;
  if (row.role === 'user' && HIDDEN_INPUT_KEYS.some(key => meta[key] !== undefined && meta[key] !== null && meta[key] !== false)) return null;
  // A delegated continuation (not something said in this chat) carries this marker as an object.
  if (row.role === 'user' && meta.autoReviewUserText && typeof meta.autoReviewUserText === 'object'
    && (meta.autoReviewUserText as { kind?: string }).kind !== 'agent-request') return null;
  // IM input keeps the person's own words apart from the context the host put around them.
  const im = row.role === 'user' && meta.imSource && typeof meta.imSource === 'object' ? meta.imSource as Record<string, unknown> : null;
  const typed = typeof im?.userText === 'string' && im.userText.trim() ? im.userText.trim() : visibleMessageText(row.role, row.content);
  const label = row.role === 'user' ? mirrorSourceLabel(meta) : null;
  const text = label && typed ? `〔${label}〕\n${typed}` : typed;
  // Attachments count on their own: an images-only message is still the owner's message.
  // Hidden synthetic inputs carry no attachments, so they stay out.
  const names = row.role === 'user' ? attachmentNames(parse(row.content)) : [];
  const result = [text, ...names.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n').trim();
  if (!result) return null;
  // With the files themselves in the room, only the typed text goes along (it may be empty).
  return options.placeholders === false ? text.trim() : result;
}

/** Split into room-sized parts without breaking surrogate pairs. */
export function splitMirrorText(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest) {
    let size = Math.min(rest.length, PART_CHARS);
    while (size > 1 && Buffer.byteLength(JSON.stringify(rest.slice(0, size))) > PART_BYTES) size = Math.floor(size * 0.8);
    if (size > 1 && size < rest.length && /[\uD800-\uDBFF]/.test(rest[size - 1]!)) size -= 1;
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return parts;
}

interface ImportMessage {
  sourceId: string; authorId: string; createdAt: string; content: Array<{ type: string; text?: string; mediaId?: string; caption?: string }>;
}

/** Room media blocks of uploaded files, in order (chatServerMedia upload). */
export type CompanionMediaUpload = (roomId: string, source: string, attachments: CompanionMirrorAttachment[], authorId: string) =>
  Promise<Array<{ type: string; mediaId?: string; caption?: string }>>;

export function createCompanionMirror(deps: {
  api: CompanionApi;
  state: CompanionCloudState;
  humanActorId: () => string;
  /** Null when the companion has no main task yet; throws when it cannot be told, so nothing counts as sent. */
  canonicalSession: (botId: string) => Promise<string | null>;
  /** Strictly after the cursor, ascending by (createdAt, id); user/assistant rows that were not rewound. */
  rowsAfter: (sessionId: string, cursor: CompanionMirrorCursor, limit: number) => Promise<CompanionMirrorRow[]>;
  /** Newest first, same filters as rowsAfter. */
  latestRows: (sessionId: string, limit: number) => Promise<CompanionMirrorRow[]>;
  /** Uploads the owner's attachments so other devices can open them; absent keeps name placeholders. */
  uploadMedia?: CompanionMediaUpload;
  /**
   * The files a companion reply refers to (generated media, files in its work folder) that go to
   * the room with it; given the reply's visible text. Absent keeps replies text only.
   */
  replyAttachments?: (botId: string, sessionId: string, row: CompanionMirrorRow, text: string) => Promise<CompanionMirrorAttachment[]>;
  log?: CompanionLog;
}) {
  async function ensureRoom(botId: string, actorId: string, name: string): Promise<string> {
    const known = deps.state.bot(botId);
    if (known?.actorId === actorId && known.roomId) return known.roomId;
    const body = { kind: 'direct', name: name.trim().slice(0, 160) || '伙伴', participants: [actorId], sourceId: actorId };
    let room: { id: string };
    try {
      room = await deps.api<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}`, ...body });
    } catch (error) {
      // An earlier attempt used another name; the room id is still keyed by the companion.
      if (!chatRejection(error, 409, 'OPERATION_CONFLICT')) throw error;
      const suffix = createHash('sha256').update(body.name).digest('hex').slice(0, 12);
      room = await deps.api<{ id: string }>('/conversations', 'POST', { operationId: `companion-room:${actorId}:${suffix}`, ...body });
    }
    deps.state.update(botId, actorId, entry => { entry.roomId = room.id; });
    return room.id;
  }

  /**
   * Import rows in order. With `advance`, the cursor moves past each fully imported row, but
   * never onto an imported (`cloud-history:`) row and never backwards. Imported ids are
   * remembered so the trailing re-scan does not send them again.
   */
  async function importRows(botId: string, actorId: string, roomId: string, sessionId: string, rows: CompanionMirrorRow[], advance = true) {
    const parts: Array<{ message: ImportMessage; row: number; last: boolean; bytes: number }> = [];
    for (const [index, row] of rows.entries()) {
      if (!mirrorMessageText(row)) continue;
      const sourceId = `cindy:${sessionId}:${row.id}`;
      const authorId = row.role === 'user' ? deps.humanActorId() : actorId;
      // The files themselves when they can be uploaded; a file that cannot (too large, gone, an old
      // address form) keeps its name in the text, as before.
      const media: Array<{ type: string; mediaId?: string; caption?: string }> = [];
      const uploaded: string[] = [];
      // A reply's files are found from what it says; a failure to look is not a reason to stop mirroring.
      const replyFiles = row.role === 'assistant' && deps.uploadMedia && deps.replyAttachments
        ? await deps.replyAttachments(botId, sessionId, row, mirrorMessageText(row, { placeholders: false }) ?? '').catch((error: unknown) => {
          deps.log?.warn('Companion reply files could not be listed', { code: errorCode(error) });
          return [];
        }) : [];
      for (const file of deps.uploadMedia ? [...mirrorAttachments(row), ...replyFiles] : []) {
        if (file.size > MIRROR_ATTACHMENT_MAX_BYTES) continue;
        try { media.push(...await deps.uploadMedia!(roomId, sourceId, [file], authorId)); uploaded.push(file.name); }
        catch (error) {
          // A file that may still go up stops this pass (the cursor stays), so the retry sends it.
          if (isTransientAttachmentFailure(error)) throw error;
          deps.log?.warn('Companion attachment upload skipped; name only', { code: errorCode(error) });
        }
      }
      // Every attachment that did not go up (as listed in the row) keeps its name in the text.
      const names = attachmentNames(parse(row.content));
      for (const name of uploaded) { const at = names.indexOf(name); if (at >= 0) names.splice(at, 1); }
      const text = media.length
        ? [mirrorMessageText(row, { placeholders: false }) ?? '', ...names.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n')
        : mirrorMessageText(row) ?? '';
      const pieces = text ? splitMirrorText(text) : [''];
      pieces.forEach((piece, n) => {
        const last = n === pieces.length - 1;
        const message: ImportMessage = {
          sourceId: `${sourceId}${n ? `:p${n}` : ''}`.slice(0, 200),
          authorId,
          createdAt: new Date(row.createdAt).toISOString(),
          content: [...(piece ? [{ type: 'text', text: piece }] : []), ...(last ? media : [])],
        };
        parts.push({ message, row: index, last, bytes: Buffer.byteLength(JSON.stringify(message)) });
      });
    }
    const moveTo = (upTo: number) => {
      if (!advance) return;
      let index = upTo;
      while (index >= 0 && rows[index]!.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)) index -= 1;
      if (index < 0) return;
      const row = rows[index]!;
      deps.state.update(botId, actorId, entry => {
        const current = entry.mirror?.sessionId === sessionId ? entry.mirror : undefined;
        if (current && (current.createdAt > row.createdAt || (current.createdAt === row.createdAt && current.id >= row.id))) return;
        entry.mirror = { sessionId, createdAt: row.createdAt, id: row.id, ...(current?.recent ? { recent: current.recent } : {}) };
      });
    };
    const remember = (ids: string[]) => {
      if (!ids.length) return;
      deps.state.update(botId, actorId, entry => {
        if (!entry.mirror || entry.mirror.sessionId !== sessionId) return;
        entry.mirror = { ...entry.mirror, recent: [...new Set([...(entry.mirror.recent ?? []), ...ids])].slice(-RECENT_IDS) };
      });
    };
    let start = 0;
    while (start < parts.length) {
      let end = start; let bytes = 0;
      while (end < parts.length && end - start < BATCH_MESSAGES && (end === start || bytes + parts[end]!.bytes <= BATCH_BYTES)) {
        bytes += parts[end]!.bytes; end += 1;
      }
      const batch = parts.slice(start, end).map(part => part.message);
      const operationId = `companion-import:${createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 48)}`;
      try {
        await deps.api(`/conversations/${roomId}/import`, 'POST', { operationId, messages: batch });
      } catch (error) {
        // The room went away (e.g. archived on the server): create it again next cycle.
        if (chatRejection(error, 404, 'CONVERSATION_NOT_FOUND')) deps.state.update(botId, actorId, entry => { delete entry.roomId; });
        throw error;
      }
      const tail = parts[end - 1]!;
      const done = tail.last ? tail.row : tail.row - 1;
      if (done >= 0) moveTo(done);
      remember([...new Set(parts.slice(start, end).filter(part => part.last).map(part => rows[part.row]!.id))]);
      start = end;
    }
    if (rows.length) moveTo(rows.length - 1);
  }

  /** One bounded pass; `drain` (before a hand-over) keeps paging until the backlog is empty. */
  async function syncBot(botId: string, actorId: string, name: string, options: { drain?: boolean } = {}): Promise<void> {
    const sessionId = await deps.canonicalSession(botId);
    if (!sessionId) return;
    const roomId = await ensureRoom(botId, actorId, name);
    const known = deps.state.bot(botId);
    const cursor = known?.actorId === actorId && known.mirror?.sessionId === sessionId ? known.mirror : null;
    if (!cursor) {
      // First run for this Session: only the most recent conversation goes up.
      const rows = (await deps.latestRows(sessionId, BACKFILL_SCAN)).reverse();
      const eligible = rows.flatMap((row, index) => mirrorMessageText(row) ? [index] : []);
      const from = eligible.length > COMPANION_BACKFILL_LIMIT ? eligible[eligible.length - COMPANION_BACKFILL_LIMIT]! : 0;
      if (rows.length) await importRows(botId, actorId, roomId, sessionId, rows.slice(from));
      else deps.state.update(botId, actorId, entry => { entry.mirror = { sessionId, createdAt: 0, id: '' }; });
      // Before a hand-over the older history goes up too: this copy stops mirroring once demoted.
      if (options.drain) await backfillBot(botId, actorId, roomId, sessionId, true);
      return;
    }
    // Assistant rows are stamped when they start and persisted later, and imported history can
    // carry a peer's clock: re-scan a trailing window behind the cursor for anything missed.
    // Server-side sourceId dedupe makes any repeat a no-op; recent ids avoid the request.
    const recent = new Set(cursor.recent ?? []);
    const behind = (row: CompanionMirrorRow) => row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.id <= cursor.id);
    const missed = (await deps.rowsAfter(sessionId, { createdAt: cursor.createdAt - RESCAN_WINDOW_MS, id: '' }, RESCAN_LIMIT))
      .filter(row => behind(row) && !recent.has(row.id) && mirrorMessageText(row));
    if (missed.length) await importRows(botId, actorId, roomId, sessionId, missed, false);
    let after: CompanionMirrorCursor = { createdAt: cursor.createdAt, id: cursor.id };
    for (let page = 0; options.drain || page < MAX_PAGES; page += 1) {
      const rows = await deps.rowsAfter(sessionId, after, PAGE);
      if (!rows.length) break;
      await importRows(botId, actorId, roomId, sessionId, rows);
      after = rows[rows.length - 1]!;
      if (rows.length < PAGE) break;
    }
    await backfillBot(botId, actorId, roomId, sessionId, options.drain === true);
  }

  /**
   * Upload the Session's history from before the mirror cursor (older conversation, or this
   * computer's own history from before it took the companion over), oldest first, a bounded
   * amount per pass. The room dedupes by source id, so rows already there are no-ops; it orders
   * by arrival, so readers sort by message time.
   */
  async function backfillBot(botId: string, actorId: string, roomId: string, sessionId: string, drain: boolean) {
    const entry = deps.state.bot(botId);
    const mirror = entry?.mirror;
    if (!mirror || mirror.sessionId !== sessionId) return;
    const progress = entry?.backfill?.sessionId === sessionId ? entry.backfill : { sessionId, createdAt: 0, id: '' };
    if (progress.done) return;
    const behindMirror = (row: CompanionMirrorRow) => row.createdAt < mirror.createdAt || (row.createdAt === mirror.createdAt && row.id <= mirror.id);
    let after: CompanionMirrorCursor = { createdAt: progress.createdAt, id: progress.id };
    for (let page = 0; drain || page < MAX_PAGES; page += 1) {
      const fetched = await deps.rowsAfter(sessionId, after, PAGE);
      const rows = fetched.filter(behindMirror);
      // Rows this computer imported recently are already in the room.
      const recent = new Set(deps.state.bot(botId)?.mirror?.recent ?? []);
      const pending = rows.filter(row => !recent.has(row.id));
      if (pending.length) await importRows(botId, actorId, roomId, sessionId, pending, false);
      if (rows.length) after = rows[rows.length - 1]!;
      const done = rows.length < fetched.length || fetched.length < PAGE;
      deps.state.update(botId, actorId, next => { next.backfill = { sessionId, createdAt: after.createdAt, id: after.id, ...(done ? { done: true } : {}) }; });
      if (done) return;
    }
  }

  return { ensureRoom, syncBot };
}
