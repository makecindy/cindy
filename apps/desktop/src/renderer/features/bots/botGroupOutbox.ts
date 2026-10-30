/**
 * Existing group-chat outbox: immediate timeline projection, per-room FIFO and stable clientId.
 * Main persists each entry and its media references before the composer relinquishes the draft.
 * Startup restores queued/failed/sent entries; transport failures retry, content/access refusals
 * remain available for editing. A receipt remains until its canonical message is read back.
 * Annotation materialization and local preview replacement reuse the same send attempt.
 * Owner changes clear this window's projection without deleting the previous owner's ledger.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isAnnotationBurnInError, materializeAnnotatedAttachmentsForSend } from '@/lib/annotationBurnIn';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';
import { setBotGroupOutboxAttachmentUrls } from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import type { BotGroupOutboxStoredEntry } from '../../../shared/botGroupOutboxStorage';
import type {
  BotGroupAttachment,
  BotGroupErrorCode,
  BotGroupMessageView,
  BotGroupQuoteView,
  BotGroupSendInput,
  BotGroupSendResult,
} from '../../../shared/botGroupChat';
import { toBotGroupAttachmentInputs } from './botGroupAttachments';
import type { BotGroupTrackedMention } from './botGroupMentions';
import { botGroupErrorKey } from './botGroupPresentation';
import { botGroupApi, getBotGroupListSnapshot, subscribeBotGroups } from './botGroupStore';

export type BotGroupOutboxStatus = 'sending' | 'sent' | 'failed';

/** The send as main receives it; attachments are prepared from `files` (see `prepared`). */
export type BotGroupOutboxSendInput = Omit<BotGroupSendInput, 'attachments'>;

/** What the composer hands over when the user presses send. */
export interface BotGroupOutboxDraft {
  /** Sent unchanged on every (re)try; `groupId` and `clientId` identify the entry. */
  input: BotGroupOutboxSendInput;
  /** Same-attempt identity from `botGroupSendSignature`: a changed field means a new clientId. */
  signature: string;
  /** The composer text as typed, put back on failure. */
  draft: string;
  /** Composer-only state put back with the draft (which typed @ picked which teammate). */
  tracked: readonly BotGroupTrackedMention[];
  /** The 引用回复 picked for this message, put back with the draft; `input.quote` is what goes out. */
  quote?: BotGroupQuoteView | null;
  files: readonly AttachedFile[];
  /** Scope for burning drawn annotations into images (see botGroupAttachmentScope). */
  attachmentScope: string;
}

/**
 * Identity of one send attempt: every field of the input except the clientId, plus the
 * attachments. A failed send may reuse its clientId only while this is unchanged.
 */
export function botGroupSendSignature(input: BotGroupOutboxSendInput, attachmentSignature: string): string {
  return JSON.stringify([{ ...input, clientId: undefined }, attachmentSignature]);
}

export interface BotGroupOutboxEntry extends BotGroupOutboxDraft {
  status: BotGroupOutboxStatus;
  createdAt: number;
  /** Highest timeline sequence known when the user pressed send: the message shows after it. */
  after: number;
  /** The attachments as the timeline shows them (the burned-in copies once `prepared`). */
  attachments: readonly BotGroupAttachment[];
  /** `files` with drawn annotations burned in; reused by every (re)try. */
  prepared?: readonly AttachedFile[];
  /** From the receipt. */
  messageId?: string;
  /** Order of the receipt against timeline reads (see `beginBotGroupTimelineRead`). */
  receiptTick?: number;
  /** Highest timeline sequence known when this entry's request started; set only while in flight. */
  baseline?: number;
  /** i18n key explaining a failure. */
  errorKey?: string;
  /** False when main refused the message itself: resending it unchanged can only fail again. */
  retryable?: boolean;
}

/** The mounted composer of a group: takes a failed message back into the input when it is empty. */
export interface BotGroupComposerHandle {
  restore: (entry: BotGroupOutboxEntry) => boolean;
  notifyFailed: (errorKey: string) => void;
}

interface GroupOutbox {
  entries: readonly BotGroupOutboxEntry[];
  chain: Promise<void>;
  /** Recent receipt ids: a re-read can never mistake them for the message still in flight. */
  claimed: string[];
  latestSequence: number;
  /** Local attachment previews of confirmed messages, by messageId, until the server copy is usable. */
  previews: ReadonlyMap<string, readonly BotGroupAttachment[]>;
}

const CLAIMED_LIMIT = 64;
/**
 * Refusals of the message's own content (a quoted original or a named teammate that is gone,
 * invalid fields or files): only 编辑 can change the outcome, so 重试 is not offered.
 */
const CONTENT_REFUSALS: ReadonlySet<BotGroupErrorCode> = new Set([
  'QUOTE_UNAVAILABLE',
  'MENTION_UNAVAILABLE',
  'INVALID_PARAMS',
  'INVALID_ATTACHMENT',
  'ATTACHMENT_TOO_LARGE',
]);
const NO_PREVIEWS: ReadonlyMap<string, readonly BotGroupAttachment[]> = new Map();
const EMPTY: readonly BotGroupOutboxEntry[] = [];

/**
 * The account the outbox holds messages for: the last non-null data owner. Only a different
 * account replaces it — not a same-owner generation repair, not the null an auth boundary
 * publishes for a moment, not signing back in to the same account.
 */
let account = getDataOwnerGeneration().dataOwnerId;

function accountChanged(): boolean {
  const current = getDataOwnerGeneration().dataOwnerId;
  return current !== null && current !== account;
}
let generation = 0;
let tick = 0;
const groups = new Map<string, GroupOutbox>();
const composers = new Map<string, BotGroupComposerHandle>();
const listeners = new Set<() => void>();
/** One burn-in per message, shared by the bubble and its submission. */
const preparing = new Map<string, Promise<readonly AttachedFile[]>>();

/**
 * Media only this outbox still refers to; storage cleanup must not sweep it. Previews of
 * confirmed messages are not listed: the send pinned those images under the group's
 * `bot-group-attachment` reference in main.
 */
function protectHeldMedia(): void {
  const urls: string[] = [];
  const add = (file: { url?: string | null; annotationSourceUrl?: string }) => {
    if (file.url) urls.push(file.url);
    if (file.annotationSourceUrl) urls.push(file.annotationSourceUrl);
  };
  for (const group of groups.values()) {
    for (const entry of group.entries) {
      entry.files.forEach(add);
      entry.prepared?.forEach(add);
    }
  }
  setBotGroupOutboxAttachmentUrls(urls);
}

function emit(): void {
  protectHeldMedia();
  for (const listener of listeners) listener();
}

/** Staged copies only a message that never reached a message still points at. */
function releaseStaged(files: readonly AttachedFile[]): void {
  if (files.length > 0) cleanupStagedChatAttachmentFiles(files);
}

/** Entries whose `submit` has started: that request owns their files until it settles. */
const submitting = new Set<string>();
const entryKey = (groupId: string, clientId: string) => `${groupId}\n${clientId}`;
const durable = () => botGroupApi()?.botGroupOutbox;
function persist(entry: BotGroupOutboxEntry): Promise<unknown> {
  return durable()?.({ action: 'put', owner: getDataOwnerGeneration(), entry: entry as unknown as BotGroupOutboxStoredEntry }) ?? Promise.resolve();
}
function forgetSaved(groupId: string, clientId: string): void {
  void durable()?.({ action: 'remove', owner: getDataOwnerGeneration(), groupId, clientId }).catch(() => undefined);
}

/** Main-window lifetime: restore once per owner and retry transport failures in room order. */
export function startBotGroupOutbox(): () => void {
  ensureOwner();
  const owner = getDataOwnerGeneration();
  let stopped = false;
  let ready = false;
  const current = () => !stopped && isDataOwnerGenerationCurrent(owner);
  const run = async () => {
    if (!current() || !owner.dataOwnerId || !durable()) return;
    if (!ready) {
      const saved = await durable()!({ action: 'list', owner });
      if (!current()) return;
      for (const value of saved) {
        const entry = value as unknown as BotGroupOutboxEntry;
        const group = groupOf(entry.input.groupId);
        if (!group.entries.some(row => row.input.clientId === entry.input.clientId)) group.entries = [...group.entries, entry];
      }
      ready = true; emit();
    }
    for (const [groupId, group] of groups) {
      const first = group.entries.find(entry => entry.status !== 'sent');
      if (first && first.retryable !== false && !submitting.has(entryKey(groupId, first.input.clientId))) {
        if (first.status === 'failed') retryBotGroupSend(groupId, first.input.clientId);
        else schedule(groupId, first.input.clientId);
      }
      if (group.entries.some(entry => entry.status === 'sent')) {
        const token = beginBotGroupTimelineRead();
        const options = group.entries.some(entry => entry.input.conversationKind === 'direct')
          ? { conversationKind: 'direct' as const } : undefined;
        let result = options ? await botGroupApi()!.getBotGroup(groupId, options) : await botGroupApi()!.getBotGroup(groupId);
        if (!current()) return;
        if (result.ok) {
          noteBotGroupTimeline(groupId, result.group.messages, token);
          // A restart may happen after many newer messages. Reconcile receipts outside
          // the newest page without moving or discarding the displayed timeline.
          while (result.ok && result.group.hasMoreBefore && group.entries.some(entry => entry.status === 'sent')) {
            const before = Math.min(...result.group.messages.map(message => message.sequence));
            if (!Number.isFinite(before)) break;
            result = await botGroupApi()!.getBotGroup(groupId, { ...options, beforeSequence: before });
            if (!current()) return;
            if (!result.ok) break;
            noteBotGroupTimeline(groupId, result.group.messages, token);
            if (!result.group.messages.some(message => message.sequence < before)) break;
          }
        }
        else if (result.errorCode === 'NOT_FOUND' || result.errorCode === 'PERMISSION_DENIED') discardBotGroupOutbox(groupId);
      }
    }
  };
  let running = false;
  const tick = () => { if (!running) { running = true; void run().catch(() => undefined).finally(() => { running = false; }); } };
  const timer = setInterval(tick, 5_000);
  window.addEventListener('online', tick); window.addEventListener('focus', tick); tick();
  return () => { stopped = true; clearInterval(timer); window.removeEventListener('online', tick); window.removeEventListener('focus', tick); };
}

/** Drop entries the outbox still owns; a request in progress settles its own (see `submit`). */
function releaseUnsubmitted(groupId: string, entries: readonly BotGroupOutboxEntry[]): void {
  for (const entry of entries) {
    if (entry.status !== 'sent' && !submitting.has(entryKey(groupId, entry.input.clientId))) releaseStaged(entry.files);
  }
}

function ensureOwner(): void {
  if (!accountChanged()) return;
  const previous = account;
  account = getDataOwnerGeneration().dataOwnerId;
  // Nothing was held for another account yet: whatever is here was written for this one.
  if (previous === null) return;
  generation += 1;
  // The previous account's queued and failed sends go with it; one being submitted settles itself.
  if (!durable()) for (const [groupId, group] of groups) releaseUnsubmitted(groupId, group.entries);
  groups.clear();
  preparing.clear();
  protectHeldMedia();
}

function groupOf(groupId: string): GroupOutbox {
  ensureOwner();
  watchGroupList();
  let group = groups.get(groupId);
  if (!group) {
    group = { entries: EMPTY, chain: Promise.resolve(), claimed: [], latestSequence: 0, previews: NO_PREVIEWS };
    groups.set(groupId, group);
  }
  return group;
}

function update(groupId: string, clientId: string, patch: Partial<BotGroupOutboxEntry>): BotGroupOutboxEntry | null {
  const group = groups.get(groupId);
  const index = group?.entries.findIndex((entry) => entry.input.clientId === clientId) ?? -1;
  if (!group || index < 0) return null;
  const next = { ...group.entries[index]!, ...patch };
  group.entries = group.entries.map((entry, at) => (at === index ? next : entry));
  void persist(next).catch(() => undefined);
  emit();
  return next;
}

function remove(groupId: string, clientId: string): void {
  const group = groups.get(groupId);
  if (!group || !group.entries.some((entry) => entry.input.clientId === clientId)) return;
  group.entries = group.entries.filter((entry) => entry.input.clientId !== clientId);
  forgetSaved(groupId, clientId);
  emit();
}

function displayAttachments(files: readonly AttachedFile[]): BotGroupAttachment[] {
  return toBotGroupAttachmentInputs(files).map((file) => ({
    id: file.id,
    name: file.name,
    category: file.category,
    mimeType: file.mimeType,
    size: file.size ?? 0,
    url: file.url ?? null,
    path: file.path || null,
    ...(file.annotated ? { annotated: true } : {}),
  }));
}

/** Show the message at once and queue it behind the group's earlier sends. */
export async function enqueueBotGroupSend(draft: BotGroupOutboxDraft): Promise<void> {
  const { groupId, clientId } = draft.input;
  const group = groupOf(groupId);
  const entry: BotGroupOutboxEntry = {
    ...draft,
    input: { ...draft.input },
    files: [...draft.files],
    tracked: [...draft.tracked],
    attachments: displayAttachments(draft.files),
    status: 'sending',
    createdAt: Date.now(),
    after: group.latestSequence,
  };
  group.entries = [...group.entries.filter((existing) => existing.input.clientId !== clientId), entry];
  // Sent again after 编辑 (same clientId): a burn that failed before is tried afresh.
  preparing.delete(entryKey(groupId, clientId));
  emit();
  if (durable()) {
    const owner = getDataOwnerGeneration();
    try { await persist(entry); }
    catch (error) { if (isDataOwnerGenerationCurrent(owner)) remove(groupId, clientId); throw error; }
    if (!isDataOwnerGenerationCurrent(owner)) throw new Error('OUTBOX_OWNER_CHANGED');
  }
  schedule(groupId, clientId);
  // Burn annotations in now, not when the message's turn comes: the bubble shows the result.
  if (entry.files.length > 0) void prepare(groupId, clientId).catch(() => undefined);
}

/**
 * The message's files with annotations burned in, once. A failure stays until 重试 clears it:
 * the early burn's failure is the message's, it never goes out on a second try nobody asked for.
 */
function prepare(groupId: string, clientId: string): Promise<readonly AttachedFile[]> {
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!entry) return Promise.reject(new Error('OUTBOX_ENTRY_GONE'));
  if (entry.prepared) return Promise.resolve(entry.prepared);
  if (entry.files.length === 0) return Promise.resolve([]);
  const key = `${groupId}\n${clientId}`;
  const existing = preparing.get(key);
  if (existing) return existing;
  const requestGeneration = generation;
  const requestOwner = getDataOwnerGeneration();
  const pending = materializeAnnotatedAttachmentsForSend(entry.files, entry.attachmentScope, { burnFailure: 'abort' })
    .then((files) => {
      const prepared = files ?? [];
      if (requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner)) {
        update(groupId, clientId, { prepared, attachments: displayAttachments(prepared) });
      }
      if (preparing.get(key) === pending) preparing.delete(key);
      return prepared;
    });
  preparing.set(key, pending);
  return pending;
}

/** 重试 on a message that did not go out: the same clientId, so main returns any copy it already has. */
export function retryBotGroupSend(groupId: string, clientId: string): void {
  ensureOwner();
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!entry || entry.status !== 'failed' || entry.retryable === false) return;
  // A burn that failed is tried again now, on the user's 重试.
  preparing.delete(entryKey(groupId, clientId));
  update(groupId, clientId, { status: 'sending', errorKey: undefined });
  schedule(groupId, clientId);
}

/** 编辑: hand a message that did not go out back to the composer. False when the input is busy. */
export function editBotGroupSend(groupId: string, clientId: string): boolean {
  ensureOwner();
  const entry = groups.get(groupId)?.entries.find((candidate) => candidate.input.clientId === clientId);
  const composer = composers.get(groupId);
  if (!entry || entry.status !== 'failed' || !composer?.restore(entry)) return false;
  remove(groupId, clientId);
  return true;
}

function schedule(groupId: string, clientId: string): void {
  const group = groupOf(groupId);
  const requestGeneration = generation;
  const requestOwner = getDataOwnerGeneration();
  // Kept by the request itself: after an account switch the entry is gone but its files are not.
  const files = group.entries.find((entry) => entry.input.clientId === clientId)?.files ?? [];
  group.chain = group.chain.then(() => submit(groupId, clientId, requestGeneration, files, requestOwner)).catch(() => undefined);
}

async function submit(
  groupId: string,
  clientId: string,
  requestGeneration: number,
  files: readonly AttachedFile[],
  requestOwner: ReturnType<typeof getDataOwnerGeneration>,
): Promise<void> {
  // An account switch nothing else noticed yet (no group open) settles the outbox here.
  ensureOwner();
  const isCurrent = () => requestGeneration === generation && !accountChanged()
    && (!durable() || isDataOwnerGenerationCurrent(requestOwner));
  // Dropped before its turn (account switch, deleted group): whoever dropped it released its files.
  if (!isCurrent()) return;
  const group = groups.get(groupId);
  const entry = group?.entries.find((candidate) => candidate.input.clientId === clientId);
  if (!group || !entry || entry.status !== 'sending') return;
  // A retryable earlier send must not be overtaken after a transport failure.
  if (durable() && group.entries.slice(0, group.entries.indexOf(entry)).some(row => row.status !== 'sent')) return;
  // From here this request owns the files. Still the outbox's message: same account, still listed.
  const owned = () =>
    isCurrent() && (groups.get(groupId)?.entries.some((candidate) => candidate.input.clientId === clientId) ?? false);
  const key = entryKey(groupId, clientId);
  submitting.add(key);
  try {
    await submitOwned(group, entry, owned, files);
  } finally {
    submitting.delete(key);
  }
}

async function submitOwned(
  group: GroupOutbox,
  entry: BotGroupOutboxEntry,
  owned: () => boolean,
  files: readonly AttachedFile[],
): Promise<void> {
  const { groupId, clientId } = entry.input;
  update(groupId, clientId, { baseline: group.latestSequence });
  const api = botGroupApi();
  let errorKey = 'bots.groupChat.composer.sendFailed';
  let retryable = true;
  try {
    if (!api) throw new Error('HOST_NOT_READY');
    // Drawn annotations are burned in first, as in a task; a failure keeps everything for a retry.
    const prepared = await prepare(groupId, clientId);
    // Dropped while annotations were burning in: it never reaches main.
    if (!owned()) {
      if (!durable()) releaseStaged(files);
      return;
    }
    const saved = groups.get(groupId)?.entries.find(row => row.input.clientId === clientId);
    if (saved) await persist(saved);
    if (!owned()) return;
    const result: BotGroupSendResult = await api.sendBotGroupMessage({
      ...entry.input,
      ...(prepared.length > 0 ? { attachments: toBotGroupAttachmentInputs(prepared) } : {}),
    });
    if (!owned()) {
      // A late answer for a dropped message: keep what went out, release what did not. Main has
      // read the files by the time it answers.
      if (!result.ok && !durable()) releaseStaged(files);
      return;
    }
    if (result.ok) {
      group.claimed = [...group.claimed, result.messageId].slice(-CLAIMED_LIMIT);
      update(groupId, clientId, { status: 'sent', messageId: result.messageId, receiptTick: ++tick, baseline: undefined });
      return;
    }
    // An original that is no longer available is not put back with the draft.
    if (result.errorCode === 'QUOTE_UNAVAILABLE') update(groupId, clientId, { quote: null });
    retryable = !CONTENT_REFUSALS.has(result.errorCode) && !['NOT_FOUND', 'PERMISSION_DENIED'].includes(result.errorCode);
    errorKey =
      result.errorCode === 'INVALID_PARAMS' && prepared.length > 0
        ? 'bots.groupChat.composer.attachmentsFailed'
        : botGroupErrorKey(result.errorCode, 'bots.groupChat.composer.sendFailed');
  } catch (error) {
    // Burn-in failed (never sent) or the call failed without an answer from main's handler.
    if (!owned()) {
      if (!durable()) releaseStaged(files);
      return;
    }
    if (isAnnotationBurnInError(error)) errorKey = 'chat.media.annotateBurnFailedNotSent';
  }
  const failed = update(groupId, clientId, { status: 'failed', errorKey, retryable, baseline: undefined });
  if (!failed) return;
  const composer = composers.get(groupId);
  if (!durable() && composer?.restore(failed)) remove(groupId, clientId);
  if (!durable() || !retryable) composer?.notifyFailed(errorKey);
}

/** Mark the start of a timeline read; pass the token to `noteBotGroupTimeline` when it lands. */
export function beginBotGroupTimelineRead(): number {
  return ++tick;
}

/**
 * A timeline read for this group succeeded. Receipts it contains, or that came back before
 * the read started, are settled: the server timeline now speaks for them.
 */
export function noteBotGroupTimeline(groupId: string, messages: readonly BotGroupMessageView[], readToken: number): void {
  const group = groupOf(groupId);
  group.latestSequence = messages.reduce((latest, message) => Math.max(latest, message.sequence), group.latestSequence);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const settled = (entry: BotGroupOutboxEntry) =>
    entry.status === 'sent' &&
    ((entry.messageId !== undefined && byId.has(entry.messageId)) || (!durable() && (entry.receiptTick ?? Infinity) < readToken));
  const previews = new Map(group.previews);
  let changed = false;
  // A settled message keeps its local previews until the timeline has a usable copy of each.
  for (const entry of group.entries) {
    if (settled(entry) && entry.messageId && entry.attachments.length > 0) previews.set(entry.messageId, entry.attachments);
  }
  for (const [messageId, local] of previews) {
    const message = byId.get(messageId);
    // A message deleted meanwhile (here or on another device) shows no attachments at all.
    if (message && (message.deleted || botGroupLocalAttachmentsSettled(message.attachments, local))) previews.delete(messageId);
  }
  if (previews.size !== group.previews.size || [...previews].some(([id, value]) => group.previews.get(id) !== value)) {
    group.previews = previews;
    changed = true;
  }
  if (group.entries.some(settled)) {
    // Messages sent later stay below the settled ones: their anchors move past the real message.
    let floor = -Infinity;
    const kept: BotGroupOutboxEntry[] = [];
    for (const entry of group.entries) {
      if (!settled(entry)) {
        kept.push(floor > entry.after ? { ...entry, after: floor } : entry);
        continue;
      }
      const sequence = entry.messageId ? byId.get(entry.messageId)?.sequence : undefined;
      forgetSaved(groupId, entry.input.clientId);
      if (sequence !== undefined) floor = Math.max(floor, sequence);
    }
    group.entries = kept;
    changed = true;
  }
  if (changed) emit();
}

/** A server attachment that can be shown: an image with its address or a file on this computer. */
function isUsable(attachment: BotGroupAttachment): boolean {
  return Boolean(attachment.url || attachment.path);
}

/**
 * Pair the server's attachments of a message with the local ones it was sent with. The server
 * keeps the order they were sent in, so equal counts pair by position. Main lists a copy only
 * once it is downloaded, and downloads finish in any order: then a name that is unique among
 * the local files pairs by name, while files sharing a name cannot be told apart and keep their
 * local previews (their server copies wait unshown) until the counts match. Local names are the
 * burned-in ones (see `prepared`), as on the server. Returns, for each local attachment, the
 * server copy it matches (or undefined), plus the server attachments no local name accounts for.
 */
function pairLocalAttachments(server: readonly BotGroupAttachment[], local: readonly BotGroupAttachment[]) {
  if (server.length === local.length) return { pairs: [...server], extra: [] as BotGroupAttachment[] };
  const counts = new Map<string, number>();
  for (const file of local) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
  const pairs = local.map((file) =>
    counts.get(file.name) === 1 ? server.find((copy) => copy.name === file.name) : undefined,
  );
  return { pairs, extra: server.filter((copy) => !counts.has(copy.name)) };
}

/**
 * What a confirmed message shows: each attachment's server copy once it is usable, the local
 * preview until then (under the server's id when known), in the order the user sent them.
 */
export function mergeBotGroupLocalAttachments(
  server: readonly BotGroupAttachment[],
  local: readonly BotGroupAttachment[],
): BotGroupAttachment[] {
  const { pairs, extra } = pairLocalAttachments(server, local);
  return [
    ...local.map((file, at) => {
      const echo = pairs[at];
      if (!echo) return file;
      return isUsable(echo) ? echo : { ...file, id: echo.id };
    }),
    ...extra,
  ];
}

/** Every local attachment has a usable server copy: the preview is no longer needed. */
function botGroupLocalAttachmentsSettled(
  server: readonly BotGroupAttachment[],
  local: readonly BotGroupAttachment[],
): boolean {
  return pairLocalAttachments(server, local).pairs.every((echo) => echo !== undefined && isUsable(echo));
}

/**
 * The group was deleted: nothing of it is left to send or show. Staged copies of files that
 * never reached a message go too; the draft no longer lists them, so nothing else would.
 */
export function discardBotGroupOutbox(groupId: string): void {
  ensureOwner();
  const group = groups.get(groupId);
  if (!group) return;
  groups.delete(groupId);
  for (const entry of group.entries) forgetSaved(groupId, entry.input.clientId);
  releaseUnsubmitted(groupId, group.entries);
  emit();
}

let unwatchGroupList: (() => void) | null = null;
const verifying = new Set<string>();
const retryTimers = new Set<ReturnType<typeof setTimeout>>();
/** A read that was not definite (thrown, or a failure other than NOT_FOUND) is tried again. */
export const BOT_GROUP_GONE_RETRY_MS = [5_000, 30_000, 120_000] as const;

/**
 * Groups deleted while their page is closed (or from another device) send no event this
 * outbox sees. The group list does: a group that drops out of it is read once more, and only
 * a definite NOT_FOUND discards its outbox (a legacy id still resolves). A read that fails is
 * retried a few times on its own: the event that dropped the group may never come again.
 */
function watchGroupList(): void {
  if (unwatchGroupList) return;
  unwatchGroupList = subscribeBotGroups(() => {
    for (const groupId of groups.keys()) verifyGroupGone(groupId, 0);
  });
}

function verifyGroupGone(groupId: string, attempt: number): void {
  if (verifying.has(groupId)) return;
  const group = groups.get(groupId);
  if (!group || (group.entries.length === 0 && group.previews.size === 0)) return;
  const list = getBotGroupListSnapshot();
  if (!list.loaded || list.groups.some((listed) => listed.id === groupId)) return;
  const api = botGroupApi();
  if (!api) return;
  const requestGeneration = generation;
  // A read that spans an owner change (same-account repair, an auth boundary's null) is no answer.
  const requestOwner = getDataOwnerGeneration();
  let definite = false;
  verifying.add(groupId);
  const options = group.entries.some(entry => entry.input.conversationKind === 'direct')
    ? { conversationKind: 'direct' as const } : undefined;
  void (options ? api.getBotGroup(groupId, options) : api.getBotGroup(groupId))
    .then((result) => {
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      definite = result.ok || result.errorCode === 'NOT_FOUND';
      if (requestGeneration === generation && !result.ok && result.errorCode === 'NOT_FOUND') discardBotGroupOutbox(groupId);
    })
    .catch(() => undefined)
    .finally(() => {
      verifying.delete(groupId);
      const delay = BOT_GROUP_GONE_RETRY_MS[attempt];
      if (definite || delay === undefined || requestGeneration !== generation) return;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (requestGeneration === generation) verifyGroupGone(groupId, attempt + 1);
      }, delay);
      retryTimers.add(timer);
    });
}

/**
 * The group's composer is on screen. A message that failed while it was away (another group,
 * share mode) comes back into it now, the same way as a failure seen in place.
 */
export function registerBotGroupComposer(groupId: string, handle: BotGroupComposerHandle): () => void {
  composers.set(groupId, handle);
  const failed = groups.get(groupId)?.entries.find((entry) => entry.status === 'failed');
  if (failed && !durable() && handle.restore(failed)) {
    remove(groupId, failed.input.clientId);
    handle.notifyFailed(failed.errorKey ?? 'bots.groupChat.composer.sendFailed');
  }
  return () => {
    if (composers.get(groupId) === handle) composers.delete(groupId);
  };
}

export interface BotGroupOutboxProjection {
  /** Server message id → local client id, to keep the same rendered row. */
  replacements: ReadonlyMap<string, string>;
  /** Entries still shown under the timeline. */
  pending: BotGroupOutboxEntry[];
  /** Local attachment previews to lay over timeline messages, by message id. */
  localAttachments: ReadonlyMap<string, readonly BotGroupAttachment[]>;
}

/**
 * Split the outbox against the timeline. A receipt already in the timeline is no longer
 * pending; so is the one request in flight once a re-read shows an unclaimed copy of it (see
 * above). Either way the real message keeps the local attachment previews until usable.
 */
export function projectBotGroupOutbox(
  entries: readonly BotGroupOutboxEntry[],
  messages: readonly BotGroupMessageView[],
  claimed: readonly string[],
  previews: ReadonlyMap<string, readonly BotGroupAttachment[]> = NO_PREVIEWS,
): BotGroupOutboxProjection {
  const localAttachments = new Map(previews);
  const replacements = new Map<string, string>();
  if (entries.length === 0) return { pending: [], localAttachments, replacements };
  const claimedIds = new Set(claimed);
  const sequenceOf = new Map(messages.map((message) => [message.id, message.sequence]));
  // A message sent later never shows above an earlier one the timeline already has.
  let floor = -Infinity;
  const pending: BotGroupOutboxEntry[] = [];
  const shown = (entry: BotGroupOutboxEntry) => {
    pending.push(floor > entry.after ? { ...entry, after: floor } : entry);
  };
  const replaced = (messageId: string, entry: BotGroupOutboxEntry) => {
    replacements.set(messageId, entry.input.clientId);
    floor = Math.max(floor, sequenceOf.get(messageId) ?? -Infinity);
    if (entry.attachments.length > 0) localAttachments.set(messageId, entry.attachments);
  };
  for (const entry of entries) {
    if (entry.status === 'sent') {
      if (entry.messageId && sequenceOf.has(entry.messageId)) replaced(entry.messageId, entry);
      else shown(entry);
      continue;
    }
    if (entry.status !== 'sending' || entry.baseline === undefined) {
      shown(entry);
      continue;
    }
    const baseline = entry.baseline;
    const copy = messages.find(
      (message) =>
        message.kind === 'message' &&
        message.authorKind === 'user' &&
        message.isSelf !== false &&
        message.sequence > baseline &&
        !claimedIds.has(message.id) &&
        message.content.trim() === entry.input.text &&
        message.attachments.length === entry.files.length,
    );
    if (copy) replaced(copy.id, entry);
    else shown(entry);
  }
  return { pending, localAttachments, replacements };
}

export type BotGroupTimelineRow =
  | { message: BotGroupMessageView; entry?: undefined }
  | { entry: BotGroupOutboxEntry; message?: undefined };

/**
 * The timeline with the messages still in the outbox where they were sent: each after the
 * messages the timeline had then, so a failed message never moves below later ones. Both lists
 * are in order (messages by sequence, entries as sent), so the anchors only grow.
 */
export function interleaveBotGroupOutbox(
  messages: readonly BotGroupMessageView[],
  pending: readonly BotGroupOutboxEntry[],
): BotGroupTimelineRow[] {
  const rows: BotGroupTimelineRow[] = [];
  let at = 0;
  for (const entry of pending) {
    while (at < messages.length && messages[at]!.sequence <= entry.after) rows.push({ message: messages[at++]! });
    rows.push({ entry });
  }
  while (at < messages.length) rows.push({ message: messages[at++]! });
  return rows;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBotGroupOutbox(groupId: string): readonly BotGroupOutboxEntry[] {
  ensureOwner();
  return groups.get(groupId)?.entries ?? EMPTY;
}

export function getBotGroupOutboxClaims(groupId: string): readonly string[] {
  ensureOwner();
  return groups.get(groupId)?.claimed ?? [];
}

export function getBotGroupOutboxPreviews(groupId: string): ReadonlyMap<string, readonly BotGroupAttachment[]> {
  ensureOwner();
  return groups.get(groupId)?.previews ?? NO_PREVIEWS;
}

export function useBotGroupOutbox(groupId: string): readonly BotGroupOutboxEntry[] {
  const read = useCallback(() => getBotGroupOutbox(groupId), [groupId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test-only reset of the module state. */
export function resetBotGroupOutboxForTests(): void {
  generation += 1;
  account = getDataOwnerGeneration().dataOwnerId;
  groups.clear();
  preparing.clear();
  verifying.clear();
  submitting.clear();
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
  unwatchGroupList?.();
  unwatchGroupList = null;
  composers.clear();
}
