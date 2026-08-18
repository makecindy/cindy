/**
 * "Joining says hello" — the first message a freshly created teammate sends.
 *
 * Shape of the mechanism, and why it is shaped this way:
 *
 *  - The greeting is a *real* assistant row in the canonical task (persisted
 *    through `localDb.messages.create`), not a renderer-only placeholder. It has
 *    to survive a reload, show up in the sidebar preview, and read exactly like
 *    every later reply.
 *  - No model turn is spent on it. The text is template copy, so writing the row
 *    directly is both cheaper and deterministic.
 *  - Which greeting belongs to which Bot is *creation* knowledge (the profile
 *    stores no template id), so the create dialog parks the template's i18n key
 *    here and the canonical chat consumes it on first open. The parking lot is
 *    localStorage, so quitting between "created" and "opened" does not lose it.
 *
 * Idempotency has three independent guards, in order:
 *   1. no parked entry → nothing to deliver (normal steady state);
 *   2. the task already has any message → the conversation has started, a
 *      greeting would barge into it; drop the entry instead;
 *   3. a deterministic `clientId` per Bot → `createMessage` is idempotent on
 *      `(sessionId, clientId)`, so even two windows racing write one row.
 */

const PENDING_WELCOME_KEY = 'cindy.bots.pendingWelcome.v1';

/** `role: 'assistant'` row id. Deterministic so a racing writer cannot duplicate it. */
export function botWelcomeClientId(botId: string): string {
  return `bot-welcome:${botId}`;
}

type PendingWelcomeMap = Record<string, string>;

function readPending(): PendingWelcomeMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PENDING_WELCOME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PendingWelcomeMap = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[botId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writePending(next: PendingWelcomeMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(PENDING_WELCOME_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_WELCOME_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the greeting is a nicety, never a blocker.
  }
}

/** Called right after a Bot is created, with the template's welcome i18n key. */
export function rememberPendingBotWelcome(botId: string, welcomeKey: string): void {
  if (!botId || !welcomeKey) return;
  writePending({ ...readPending(), [botId]: welcomeKey });
}

export function peekPendingBotWelcome(botId: string): string | null {
  return readPending()[botId] ?? null;
}

export function clearPendingBotWelcome(botId: string): void {
  const current = readPending();
  if (!(botId in current)) return;
  delete current[botId];
  writePending(current);
}

/** Test seam so unit tests do not have to poke localStorage directly. */
export function resetPendingBotWelcomeForTests(): void {
  writePending({});
}

export interface BotWelcomeMessageBody {
  clientId: string;
  role: 'assistant';
  content: string;
}

export interface DeliverBotWelcomeDeps {
  /** Existing rows in the canonical task; only "is it empty" matters. */
  listMessages: (sessionId: string) => Promise<unknown>;
  createMessage: (sessionId: string, body: BotWelcomeMessageBody) => Promise<unknown>;
  /** Resolves the parked i18n key to the localized greeting. */
  translate: (key: string) => string;
}

/**
 * Deliver the parked greeting into `sessionId`, once.
 *
 * Returns true only when this call actually wrote the row — tests assert on it,
 * and it keeps the "second open does nothing" contract explicit.
 */
export async function deliverPendingBotWelcome(
  botId: string,
  sessionId: string,
  deps: DeliverBotWelcomeDeps,
): Promise<boolean> {
  const welcomeKey = peekPendingBotWelcome(botId);
  if (!welcomeKey) return false;
  const text = deps.translate(welcomeKey).trim();
  if (!text || text === welcomeKey) {
    // A missing catalog entry must not persist the raw key into the chat.
    clearPendingBotWelcome(botId);
    return false;
  }
  let existing: unknown;
  try {
    existing = await deps.listMessages(sessionId);
  } catch {
    // Could not prove the task is empty — leave the entry parked and retry on
    // the next open rather than risk barging into an ongoing conversation.
    return false;
  }
  const rows = Array.isArray(existing)
    ? existing
    : Array.isArray((existing as { messages?: unknown } | null)?.messages)
      ? ((existing as { messages: unknown[] }).messages)
      : [];
  if (rows.length > 0) {
    clearPendingBotWelcome(botId);
    return false;
  }
  try {
    await deps.createMessage(sessionId, {
      clientId: botWelcomeClientId(botId),
      role: 'assistant',
      content: text,
    });
  } catch {
    return false;
  }
  clearPendingBotWelcome(botId);
  return true;
}
