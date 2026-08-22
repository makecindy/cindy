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
 *  - 阵容页脚注写着「加入后 TA 会先跟你打个招呼」,那是**对所有创建路径**的承诺,
 *    不只是模板卡。所以寄存的东西从「一个 i18n key」放宽成三选一:
 *      · `key`            —— 模板欢迎语,或通用开场句(手捏路径);
 *      · `key` + `params` —— 通用开场句带上这个伙伴的名字 / 定位;
 *      · `text`           —— 已经成句的整段话(AI 生成路径里模型现造的开场白),
 *                            有它就直接用,不查目录。
 *    旧版本只存 key 字符串,`readPending` 仍认那种形状 —— 升级前建好、升级后
 *    才第一次打开的伙伴不能因此变哑。
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

/** 寄存的一条开场白。`text` 优先于 `key`。 */
export interface PendingBotWelcome {
  /** i18n key。`text` 缺席时用它(可带 `params` 插值)。 */
  key: string;
  /** `t(key, params)` 的插值,如伙伴的名字与一句话定位。 */
  params?: Record<string, string>;
  /** 已经成句的整段话;有它就不查目录。 */
  text?: string;
}

type PendingWelcomeMap = Record<string, PendingBotWelcome>;

/** 旧形状(裸 key 字符串)与新形状都要认;认不出来的一律丢掉,不写脏数据进对话。 */
function normalizeEntry(value: unknown): PendingBotWelcome | null {
  if (typeof value === 'string') return value ? { key: value } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = typeof record.key === 'string' ? record.key : '';
  const text = typeof record.text === 'string' && record.text.trim() ? record.text.trim() : undefined;
  if (!key && !text) return null;
  const params: Record<string, string> = {};
  if (record.params && typeof record.params === 'object' && !Array.isArray(record.params)) {
    for (const [name, raw] of Object.entries(record.params as Record<string, unknown>)) {
      if (typeof raw === 'string') params[name] = raw;
    }
  }
  return {
    key,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(text ? { text } : {}),
  };
}

function readPending(): PendingWelcomeMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PENDING_WELCOME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PendingWelcomeMap = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (entry) out[botId] = entry;
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

/**
 * Called right after a Bot is created. 接受模板那样的裸 i18n key,也接受
 * 带插值 / 现成整句的完整条目。
 */
export function rememberPendingBotWelcome(
  botId: string,
  welcome: string | PendingBotWelcome,
): void {
  if (!botId) return;
  const entry = normalizeEntry(welcome);
  if (!entry) return;
  writePending({ ...readPending(), [botId]: entry });
}

/** 只要 key(模板路径的既有读法)。现成整句的条目在这里返回 null。 */
export function peekPendingBotWelcome(botId: string): string | null {
  const entry = readPending()[botId];
  return entry?.key ? entry.key : null;
}

/** 完整条目 —— 需要看插值或现成整句时用。 */
export function peekPendingBotWelcomeEntry(botId: string): PendingBotWelcome | null {
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
  /** Resolves the parked i18n key (with optional interpolation) to the greeting. */
  translate: (key: string, params?: Record<string, string>) => string;
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
  const entry = peekPendingBotWelcomeEntry(botId);
  if (!entry) return false;
  // 现成整句(生成路径)不查目录;否则按 key + 插值取本地化文案。
  const text = entry.text
    ? entry.text.trim()
    : deps.translate(entry.key, entry.params).trim();
  if (!text || text === entry.key) {
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
