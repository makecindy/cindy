import { createHash, randomUUID } from 'node:crypto';
import { decodeLaneUserId } from './codec.js';
import { getHost, getScope } from './moduleScope.js';
import { firstAllowed, check } from './ownerGuard.js';
import { readAppId } from './storage.js';
import {
  callApi,
  getAccountEpoch,
  getMessage,
  pushReplyAnchor,
  sendCardRaw,
} from './outbound.js';
import type { IMMessageEvent } from '../types.js';

const MARKER = '__cindy_managed_card';
const MAX_CARDS = 256;
const MAX_RECEIPTS = 1024;
const DAY = 86400_000;
interface Registration {
  requestId: string;
  uuid: string;
  digest: string;
  lane: string;
  chatId: string;
  messageId?: string;
  expiresAt: number;
  receipts: Record<string, number>;
}
interface Registry {
  version: 1;
  appId: string;
  owner: string;
  cards: Registration[];
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function storage() {
  const store = getHost().managedCards;
  if (!store) throw new Error('MANAGED_CARD_STORAGE_UNAVAILABLE');
  return store;
}
function identity() {
  const appId = readAppId();
  const owner = firstAllowed();
  if (!appId || !owner) throw new Error('MANAGED_CARD_IDENTITY_UNAVAILABLE');
  return { appId, owner, key: getScope().secretKeyPrefix };
}
function readRegistry(): Registry | null {
  const raw = storage().read(getScope().secretKeyPrefix);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) return null;
  if (
    !object(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.appId !== 'string' ||
    typeof parsed.owner !== 'string' ||
    !Array.isArray(parsed.cards) ||
    parsed.cards.length > MAX_CARDS ||
    !parsed.cards.every(
      (card) =>
        object(card) &&
        ['requestId', 'uuid', 'digest', 'lane', 'chatId'].every(
          (key) => typeof card[key] === 'string',
        ) &&
        (card.messageId === undefined || typeof card.messageId === 'string') &&
        typeof card.expiresAt === 'number' &&
        Number.isFinite(card.expiresAt) &&
        object(card.receipts) &&
        Object.entries(card.receipts).length <= MAX_RECEIPTS &&
        Object.entries(card.receipts).every(
          ([key, time]) =>
            /^[a-f0-9]{64}$/.test(key) && typeof time === 'number',
        ),
    )
  ) {
    throw new Error('MANAGED_CARD_REGISTRY_INVALID');
  }
  return parsed as unknown as Registry;
}

/** Namespace callbacks so even expired/rebound business cards cannot enter system controls. */
function namespaceCallbacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(namespaceCallbacks);
  if (!object(value)) return value;
  const next = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      namespaceCallbacks(child),
    ]),
  );
  if (value.type === 'callback') {
    next.value = { [MARKER]: true, original: value.value };
  } else if (
    [
      'button',
      'checker',
      'select_static',
      'select_person',
      'multi_select_static',
      'multi_select_person',
      'date_picker',
      'picker_time',
      'picker_datetime',
      'overflow',
    ].includes(String(value.tag)) &&
    !Array.isArray(value.behaviors)
  ) {
    // Schema 2.0 uses callback behaviors; preserve link-only controls without adding a submit.
    if (!value.url && !value.multi_url) {
      delete next.value;
      next.behaviors = [
        { type: 'callback', value: { [MARKER]: true, original: value.value } },
      ];
    }
  }
  return next;
}
function serializeCard(card: Record<string, unknown>): string {
  if (
    card.schema !== '2.0' ||
    !object(card.body) ||
    !Array.isArray(card.body.elements)
  ) {
    throw new Error('MANAGED_CARD_REQUIRES_SCHEMA_2_BODY_ELEMENTS');
  }
  const content = JSON.stringify(namespaceCallbacks(card));
  if (Buffer.byteLength(content, 'utf8') > 28_000)
    throw new Error('MANAGED_CARD_TOO_LARGE');
  return content;
}

/** Send once; registration is independent of any live ask/permission Promise. */
export async function sendManagedCard(
  lane: string,
  card: Record<string, unknown>,
  requestId: string,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
    throw new Error('INVALID_CARD_REQUEST_ID');
  const content = serializeCard(card);
  const { appId, owner, key } = identity();
  const epoch = getAccountEpoch();
  const accountScope = getHost().accountScope;
  const accountToken = accountScope?.capture();
  if (accountScope && accountToken == null)
    throw new Error('MANAGED_CARD_ACCOUNT_UNAVAILABLE');
  const accountIsCurrent = () =>
    !accountScope || accountScope.isCurrent(accountToken);
  const store = storage();
  const previous = readRegistry();
  const registry: Registry =
    previous?.appId === appId && previous.owner === owner
      ? previous
      : { version: 1, appId, owner, cards: [] };
  registry.cards = registry.cards.filter(
    (entry) => entry.expiresAt > Date.now(),
  );
  const digest = hash(content);
  const existing = registry.cards.find(
    (entry) => entry.lane === lane && entry.requestId === requestId,
  );
  if (existing) {
    if (existing.digest !== digest)
      throw new Error('CARD_REQUEST_ID_REUSED_WITH_DIFFERENT_CONTENT');
    if (!existing.messageId)
      throw new Error('CARD_DELIVERY_UNKNOWN_DO_NOT_RESEND');
    return {
      messageId: existing.messageId,
      registered: true,
      expiresAt: existing.expiresAt,
    };
  }
  if (registry.cards.length >= MAX_CARDS)
    throw new Error('MANAGED_CARD_REGISTRY_FULL');
  const group = decodeLaneUserId(lane);
  if (!group && lane !== owner)
    throw new Error('MANAGED_CARD_TARGET_MUST_BE_OWNER_OR_GROUP_LANE');
  const entry: Registration = {
    requestId,
    uuid: randomUUID(),
    digest,
    lane,
    chatId: group?.chatId ?? '',
    expiresAt: Date.now() + 30 * DAY,
    receipts: {},
  };
  registry.cards.push(entry);
  // Persist intent before network I/O. An ambiguous timeout must not create another card on retry.
  store.write(key, JSON.stringify(registry));
  // Reuse transport topic/anchor routing, never treat an omt_ thread id as an om_ message id.
  const receipt = await sendCardRaw(lane, JSON.parse(content));
  const sent = { messageId: receipt.messageId, expiresAt: entry.expiresAt };
  // A remote receipt proves delivery even if the account changes or local persistence fails.
  if (
    !accountIsCurrent() ||
    epoch !== getAccountEpoch() ||
    readAppId() !== appId ||
    firstAllowed() !== owner
  ) {
    return { ...sent, registered: false };
  }
  entry.messageId = receipt.messageId;
  if (!group) {
    try {
      const message = await getMessage(receipt.messageId);
      if (!message || typeof message.chat_id !== 'string')
        return { ...sent, registered: false };
      entry.chatId = message.chat_id;
    } catch {
      return { ...sent, registered: false };
    }
    if (
      !accountIsCurrent() ||
      epoch !== getAccountEpoch() ||
      readAppId() !== appId ||
      firstAllowed() !== owner
    )
      return { ...sent, registered: false };
  }
  // Merge concurrent sends/callback receipts instead of overwriting their registration.
  try {
    const latest = readRegistry();
    if (!latest || latest.appId !== appId || latest.owner !== owner)
      return { ...sent, registered: false };
    const index = latest.cards.findIndex((item) => item.uuid === entry.uuid);
    if (index < 0) return { ...sent, registered: false };
    latest.cards[index] = entry;
    store.write(key, JSON.stringify(latest));
  } catch {
    return { ...sent, registered: false };
  }
  return { ...sent, registered: true };
}

export async function updateManagedCard(
  lane: string,
  messageId: string,
  card: Record<string, unknown>,
) {
  const content = serializeCard(card);
  const { appId, owner } = identity();
  const registry = readRegistry();
  if (
    registry?.appId !== appId ||
    registry.owner !== owner ||
    !registry.cards.some(
      (entry) =>
        entry.messageId === messageId &&
        entry.lane === lane &&
        entry.expiresAt > Date.now(),
    )
  ) {
    throw new Error('CARD_NOT_REGISTERED_FOR_CURRENT_LANE');
  }
  await callApi({
    method: 'PATCH',
    path: '/open-apis/im/v1/messages/' + encodeURIComponent(messageId),
    data: { content },
  });
}

/** null = legacy/system card; false = rejected managed callback; true = accepted. */
export function receiveManagedCardAction(
  raw: unknown,
  isCurrent: () => boolean,
): boolean | null {
  if (!object(raw) || !object(raw.action)) return null;
  const wrapped = object(raw.action.value) && raw.action.value[MARKER] === true;
  // A damaged business registry must not disable unrelated permission/ask cards.
  if (!wrapped) return null;
  // Old hosts remain compatible and never gain business callback capability implicitly.
  if (!getScope().host?.managedCards) return false;
  const context = object(raw.context) ? raw.context : raw;
  const messageId = context.open_message_id;
  const registry = readRegistry();
  const entry = registry?.cards.find((card) => card.messageId === messageId);
  if (!entry) return false;
  const sender = object(raw.operator) ? raw.operator.open_id : undefined;
  const { appId, owner, key } = identity();
  const scope = getScope();
  const group = decodeLaneUserId(entry.lane);
  if (
    registry!.appId !== appId ||
    registry!.owner !== owner ||
    entry.chatId !== context.open_chat_id ||
    entry.expiresAt <= Date.now() ||
    typeof sender !== 'string' ||
    !sender ||
    (!check(sender) && (!group || !scope.guests)) ||
    !isCurrent() ||
    !scope.events.listenerCount('message')
  )
    return false;
  if (typeof raw.token !== 'string' || !raw.token || raw.token.length > 4096)
    return false;
  const eventId = hash(raw.token);
  if (entry.receipts[eventId]) return true;
  entry.receipts = Object.fromEntries(
    Object.entries(entry.receipts).filter(
      ([, time]) => time > Date.now() - DAY,
    ),
  );
  if (Object.keys(entry.receipts).length >= MAX_RECEIPTS) return false;
  const action = {
    ...raw.action,
    ...(wrapped
      ? { value: (raw.action.value as Record<string, unknown>).original }
      : {}),
  };
  const text = JSON.stringify({
    type: 'feishu_card_action',
    requestId: entry.requestId,
    eventId,
    messageId,
    operatorId: sender,
    isOwner: check(sender),
    action,
  });
  if (Buffer.byteLength(text, 'utf8') > 32_000) return false;
  entry.receipts[eventId] = Date.now();
  storage().write(key, JSON.stringify(registry));
  const event: IMMessageEvent = {
    channelName: 'feishu',
    contextId: appId,
    senderId: entry.lane,
    chatId: entry.chatId,
    messageId: entry.messageId!,
    text,
    invoked: true,
    ...(group
      ? { speaker: { id: sender, name: '', isOwner: check(sender) } }
      : {}),
    attachments: [],
    unsupported: [],
  };
  setImmediate(() => {
    if (!isCurrent() || firstAllowed() !== owner || readAppId() !== appId)
      return;
    if (group) pushReplyAnchor(entry.lane, entry.messageId!);
    scope.events.emit('message', event);
  });
  return true;
}
