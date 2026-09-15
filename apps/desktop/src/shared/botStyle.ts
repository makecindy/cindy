/**
 * 伙伴沟通风格。结构化字段走 bot profile / capabilitiesJson,和性别同款,
 * 不另开一列,也不进 renderer localStorage。
 *
 * 风格块只约束「怎么说」,不覆盖 SOUL.md 身份正本;伙伴自己也不得改写——伙伴没有工具能写 Profile(只有 main-side IPC),提示词也明确禁止改写风格。
 */

export const BOT_STYLE_TONES = [
  'warm',
  'professional',
  'playful',
  'concise',
  'custom',
] as const;

export type BotStyleTone = (typeof BOT_STYLE_TONES)[number];

export const BOT_STYLE_REPLY_LENGTHS = ['short', 'medium', 'long'] as const;

export type BotStyleReplyLength = (typeof BOT_STYLE_REPLY_LENGTHS)[number];

export const BOT_STYLE_EMOJI_DENSITIES = ['none', 'sparse', 'normal'] as const;

export type BotStyleEmojiDensity = (typeof BOT_STYLE_EMOJI_DENSITIES)[number];

export const BOT_STYLE_LIMITS = {
  customTone: 400,
  addressUserAs: 80,
  selfName: 80,
  bannedPhrases: 1000,
  bannedPhraseItems: 40,
  languageHabits: 2000,
} as const;

export interface BotCommunicationStyle {
  tone?: BotStyleTone;
  customTone?: string;
  addressUserAs?: string;
  selfName?: string;
  replyLength?: BotStyleReplyLength;
  emojiDensity?: BotStyleEmojiDensity;
  bannedPhrases?: string;
  languageHabits?: string;
}

export const BOT_STYLE_KEYS = [
  'tone',
  'customTone',
  'addressUserAs',
  'selfName',
  'replyLength',
  'emojiDensity',
  'bannedPhrases',
  'languageHabits',
] as const satisfies readonly (keyof BotCommunicationStyle)[];

const TONE_SET = new Set<string>(BOT_STYLE_TONES);
const REPLY_LENGTH_SET = new Set<string>(BOT_STYLE_REPLY_LENGTHS);
const EMOJI_SET = new Set<string>(BOT_STYLE_EMOJI_DENSITIES);

function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function isTone(value: unknown): value is BotStyleTone {
  return typeof value === 'string' && TONE_SET.has(value);
}

function isReplyLength(value: unknown): value is BotStyleReplyLength {
  return typeof value === 'string' && REPLY_LENGTH_SET.has(value);
}

function isEmojiDensity(value: unknown): value is BotStyleEmojiDensity {
  return typeof value === 'string' && EMOJI_SET.has(value);
}

/** 投影 / 草稿归一化:脏枚举丢掉,超长文本截断,全空则视为未设置。 */
export function normalizeBotStyle(value: unknown): BotCommunicationStyle | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const next: BotCommunicationStyle = {};
  if (isTone(raw.tone)) next.tone = raw.tone;
  const customTone = clipText(raw.customTone, BOT_STYLE_LIMITS.customTone);
  if (customTone) next.customTone = customTone;
  const addressUserAs = clipText(raw.addressUserAs, BOT_STYLE_LIMITS.addressUserAs);
  if (addressUserAs) next.addressUserAs = addressUserAs;
  const selfName = clipText(raw.selfName, BOT_STYLE_LIMITS.selfName);
  if (selfName) next.selfName = selfName;
  if (isReplyLength(raw.replyLength)) next.replyLength = raw.replyLength;
  if (isEmojiDensity(raw.emojiDensity)) next.emojiDensity = raw.emojiDensity;
  const bannedPhrases = clipBannedPhrases(raw.bannedPhrases);
  if (bannedPhrases) next.bannedPhrases = bannedPhrases;
  const languageHabits = clipText(raw.languageHabits, BOT_STYLE_LIMITS.languageHabits);
  if (languageHabits) next.languageHabits = languageHabits;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function botStyleEqual(
  a: BotCommunicationStyle | null | undefined,
  b: BotCommunicationStyle | null | undefined,
): boolean {
  return JSON.stringify(normalizeBotStyle(a) ?? null) === JSON.stringify(normalizeBotStyle(b) ?? null);
}

/**
 * Apply this window's style-field additions/removals onto the latest persisted
 * object so a later save of `addressUserAs` does not wipe a concurrent `tone`.
 * Keys equal to the editing baseline take the remote value; keys this window
 * changed keep the local value (including explicit clears).
 */
export function reconcileBotStyle(
  previous: BotCommunicationStyle | null | undefined,
  local: BotCommunicationStyle | null | undefined,
  remote: BotCommunicationStyle | null | undefined,
): BotCommunicationStyle | undefined {
  const baseline = normalizeBotStyle(previous) ?? {};
  const selected = normalizeBotStyle(local) ?? {};
  const current = normalizeBotStyle(remote) ?? {};
  // Indexed writes through BotCommunicationStyle collapse optional unions to
  // `undefined` (TS2322). Partial Record keeps the target `string | undefined`.
  // Cleared keys stay omitted (undefined), never `''`.
  const next: Partial<Record<keyof BotCommunicationStyle, string>> = {};
  for (const key of BOT_STYLE_KEYS) {
    const value = baseline[key] === selected[key] ? current[key] : selected[key];
    if (value !== undefined) next[key] = value;
  }
  return Object.keys(next).length > 0 ? (next as BotCommunicationStyle) : undefined;
}

const TONE_GUIDANCE: Record<Exclude<BotStyleTone, 'custom'>, string> = {
  warm: '温暖、亲近,像熟识的同事;认真做事,但不端着。',
  professional: '专业、克制,把事情讲清楚;少闲话,不卖弄。',
  playful: '轻松、有点幽默,但不油腻,也不拿用户寻开心。',
  concise: '简练直接,少铺垫;能一句说完就不要三段。',
};

const REPLY_LENGTH_GUIDANCE: Record<BotStyleReplyLength, string> = {
  short: '默认短回复;用户明确要求展开时再写细。',
  medium: '详略适中,把要点讲全,但不注水。',
  long: '可以讲细、给步骤和取舍,但仍避免车轱辘话。',
};

const EMOJI_GUIDANCE: Record<BotStyleEmojiDensity, string> = {
  none: '不要使用 emoji。',
  sparse: '偶尔用一个,不连发,不靠表情撑场面。',
  normal: '可以自然使用,不要刷屏。',
};

function splitBannedPhrases(text: string): string[] {
  return text
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, BOT_STYLE_LIMITS.bannedPhraseItems);
}

function clipBannedPhrases(value: unknown): string | undefined {
  const text = clipText(value, BOT_STYLE_LIMITS.bannedPhrases);
  if (!text) return undefined;
  const items = splitBannedPhrases(text);
  return items.length > 0 ? items.join('\n') : undefined;
}

/**
 * 注入 stable 层尾部的风格说明。空配置返回空串,调用方一个字都不提。
 * 身份仍以 SOUL 为准;这段只约束说话方式。
 */
export function buildBotStyleGuidance(style: BotCommunicationStyle | undefined): string {
  const normalized = normalizeBotStyle(style);
  if (!normalized) return '';
  const lines: string[] = [
    '## 说话习惯',
    '这是用户给你设的沟通风格。它只约束你怎么说,不覆盖上面的身份(SOUL)。身份以 SOUL 为准;不要自行改写这段风格,也不要改 SOUL 或 system_prompt。',
  ];
  if (normalized.tone === 'custom') {
    const custom = normalized.customTone?.trim();
    if (custom) lines.push(`- 语气: ${custom}`);
  } else if (normalized.tone) {
    lines.push(`- 语气: ${TONE_GUIDANCE[normalized.tone]}`);
  }
  if (normalized.addressUserAs) {
    lines.push(`- 称呼用户为「${normalized.addressUserAs}」。`);
  }
  if (normalized.selfName) {
    lines.push(`- 自称「${normalized.selfName}」。`);
  }
  if (normalized.replyLength) {
    lines.push(`- 回复长度: ${REPLY_LENGTH_GUIDANCE[normalized.replyLength]}`);
  }
  if (normalized.emojiDensity) {
    lines.push(`- emoji: ${EMOJI_GUIDANCE[normalized.emojiDensity]}`);
  }
  const banned = normalized.bannedPhrases ? splitBannedPhrases(normalized.bannedPhrases) : [];
  if (banned.length > 0) {
    lines.push(`- 不要说: ${banned.map((item) => `「${item}」`).join('、')}。`);
  }
  if (normalized.languageHabits) {
    lines.push(`- 语言习惯: ${normalized.languageHabits}`);
  }
  // 只有标题、没有一条具体约束时不注入,避免空头「说话习惯」。
  return lines.length > 2 ? lines.join('\n') : '';
}
