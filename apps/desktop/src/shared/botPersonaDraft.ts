/**
 * 「角色生成助手」的 wire 契约 —— 一句话角色描述 → 一份可编辑的伙伴草稿。
 *
 * 分层:
 *   - 本文件(shared,纯函数):prompt 组装 + 模型输出的 schema 校验 + 错误码。
 *     renderer 与 main 共用同一份形状,不各写一遍。
 *   - `main/maker-ipc/botPersonaGeneration.ts`:把 prompt 交给**既有的**一次性
 *     模型通道(title one-shot,见该文件注释),不新开供应商 / 端点 / 凭证路径。
 *   - `renderer/features/bots/botPersonaGenerate.ts`:把草稿折算成创建 payload。
 *
 * **草稿不是配置**:生成结果只是预填,用户在预览卡上逐项改完才落库。所以这里的
 * 校验一律「宽进严出」——拿不到的字段用空串/默认值补,拿到但形状不对的整份判失败,
 * 绝不把半截 JSON 当成一个伙伴创建出来。
 */

export const BOT_PERSONA_DRAFT_STYLES = ['concise', 'lively', 'steady'] as const;
export const BOT_PERSONA_DRAFT_PROACTIVITIES = ['reactive', 'proactive', 'reportAll'] as const;
/**
 * 生成器只在「直呼名字 / 老板」之间选。
 *
 * 向导的第三档是 `custom`(用户自己填一个称呼),那是**用户才知道**的东西:模型
 * 编一个「主人」「船长」出来只会让人一进设置就先去改掉它。
 */
export const BOT_PERSONA_DRAFT_CALLS = ['name', 'boss'] as const;

export type BotPersonaDraftStyle = (typeof BOT_PERSONA_DRAFT_STYLES)[number];
export type BotPersonaDraftProactivity = (typeof BOT_PERSONA_DRAFT_PROACTIVITIES)[number];
export type BotPersonaDraftCall = (typeof BOT_PERSONA_DRAFT_CALLS)[number];

/** 生成出来的一条初始记忆(slug 由本地派生,不让模型起文件名)。 */
export interface BotPersonaDraftMemory {
  title: string;
  description: string;
  body: string;
}

export interface BotPersonaDraft {
  /** 名字建议。 */
  name: string;
  /** 一句话简介(落 profile.description)。 */
  description: string;
  /** 完整背景设定,落 identitySource 的背景正文段。 */
  identity: string;
  /**
   * 这个伙伴加入后自己说的第一句话(第一人称)。
   *
   * 阵容页脚注对**所有**创建路径都承诺「加入后 TA 会先跟你打个招呼」,模板伙伴
   * 有自己的 welcome 文案,生成出来的伙伴没有 —— 与其另跑一次模型,不如在同一份
   * JSON 里多要一个字段。拿不到就回落到带名字的模板句,不会因此变哑。
   */
  greeting: string;
  style: BotPersonaDraftStyle;
  proactivity: BotPersonaDraftProactivity;
  call: BotPersonaDraftCall;
  /**
   * 建议头像。两个都是**未经校验的字符串**:合法的预置立绘 id / 色相由 renderer
   * 侧的 `BOT_PRESET_AVATAR_IDS` / `BOT_AVATAR_HUES` 判定(那是渲染层的词汇表,
   * main 不该 import 它)。认不出来时 renderer 回落到按名字哈希分配的头像。
   */
  avatarPreset: string;
  avatarHue: string;
  memories: BotPersonaDraftMemory[];
}

/**
 * 失败分类。**每一类都必须给用户一句人话**,不许静默失败——这是这条链路的硬要求:
 * 点了「帮我生成」什么都没发生,比明说"现在生成不了,你可以自己写"糟糕得多。
 *
 *  - `empty-input`      —— 用户没写角色就点了生成(本地判定,不发请求)。
 *  - `provider-not-ready` —— 一个可用的模型来源都没有(未登录 / 全部断开)。
 *    与 `ACCOUNT_PROVIDER_NOT_READY` 是同一类现实:能力在,账号不在。
 *  - `generation-failed`  —— 请求发出去了但没拿到可用回答(超时 / HTTP 失败 / 空)。
 *  - `invalid-output`     —— 拿到了回答但不是我们要的形状(schema 校验没过)。
 */
export type BotPersonaGenerateErrorCode =
  | 'empty-input'
  | 'provider-not-ready'
  | 'generation-failed'
  | 'invalid-output';

export type BotPersonaGenerateResult =
  | { ok: true; draft: BotPersonaDraft }
  | { ok: false; code: BotPersonaGenerateErrorCode };

/** 用户输入的角色描述上限:一句话就行,再长也不多帮忙。 */
export const BOT_PERSONA_ROLE_MAX_CHARS = 120;

const MAX_NAME_CHARS = 24;
const MAX_DESCRIPTION_CHARS = 60;
const MAX_IDENTITY_CHARS = 1200;
/** 开场白是一句话见面语,不是一段介绍。 */
const MAX_GREETING_CHARS = 200;
const MAX_MEMORY_TITLE_CHARS = 40;
const MAX_MEMORY_DESCRIPTION_CHARS = 120;
const MAX_MEMORY_BODY_CHARS = 600;
/** 最多留 3 条初始记忆——再多用户在预览卡上就只会往下划,不会逐条读。 */
export const BOT_PERSONA_DRAFT_MAX_MEMORIES = 3;

/**
 * 生成 prompt。语言跟随界面语言(locale 直接给模型,让它自己按该语言写),
 * 输出形状用一段 JSON schema 说明约束。
 *
 * system / user 分开返回:一次性通道对 Anthropic wire 会把 system 写进顶层
 * `system` 字段,对 gateway wire 会作为 `role: 'system'` 消息 —— 素材与指令
 * 分开传是那条通道已有的用法(见 promptPrediction)。
 */
export function buildBotPersonaPrompt(role: string, locale: string): {
  system: string;
  user: string;
} {
  const trimmedRole = role.trim().slice(0, BOT_PERSONA_ROLE_MAX_CHARS);
  const system = [
    'You design a persistent AI teammate profile from one short role description.',
    `Write every human-readable field in the language of this locale: ${locale}.`,
    'Return ONE JSON object and nothing else — no prose, no markdown fence, no comments.',
    'Schema:',
    '{',
    '  "name": string,            // a short given name for the teammate, not a job title',
    '  "description": string,     // one short line describing what this teammate is for',
    '  "identity": string,        // 3-6 sentences of durable role, temperament and scope,',
    '                             // written as a brief addressed to the teammate itself',
    '  "greeting": string,        // one or two short first-person sentences this teammate',
    '                             // says when it joins, in its own voice',
    '  "style": "concise" | "lively" | "steady",',
    '  "proactivity": "reactive" | "proactive" | "reportAll",',
    '  "call": "name" | "boss",',
    '  "avatarPreset": "shiba" | "whitecat" | "robot" | "dino" | "melody" | "star" | "butler" | "owl",',
    '  "avatarHue": "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "pink" | "graphite",',
    `  "memories": [{ "title": string, "description": string, "body": string }] // 2-3 items`,
    '}',
    'Rules for "greeting": speak as the teammate, mention its own name once, and end',
    'with an opening for the owner. Never claim anything has been done already.',
    'Rules for "identity": describe the teammate — its job, temperament and limits.',
    'Never invent facts about the human owner (no name, job, family, schedule or preferences).',
    'Rules for "memories": each one is a working convention this teammate starts out holding',
    'about its own craft (how it reports, how small it keeps changes, what it double-checks).',
    'They must NOT be claims about the owner, and must not assert anything already done.',
  ].join('\n');
  const user = `Role description: ${trimmedRole}`;
  return { system, user };
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim().slice(0, max);
}

function readBlock(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // 段内换行保留(背景设定是多句话),但去掉首尾空白与 3 连以上空行。
  return value.replace(/\n{3,}/gu, '\n\n').trim().slice(0, max);
}

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 即便 prompt 明说"只输出 JSON",实测仍会出现 ```json 围栏或前后一句寒暄。
 * 这里只做**一次**最外层大括号切片,不做花式修复:修不出来就判 invalid-output,
 * 让用户看到一句真话,而不是拿到一个被猜出来的伙伴。
 */
function sliceJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * 模型原始输出 → 草稿。**名字和背景设定是硬要求**:两者缺一,这份草稿就填不满
 * 预览卡的主体,判失败让用户重试或改走手写,比给一张半空的卡强。
 */
export function parseBotPersonaDraft(raw: string): BotPersonaDraft | null {
  if (typeof raw !== 'string') return null;
  const json = sliceJsonObject(raw);
  if (!json) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;

  const name = readLine(record.name, MAX_NAME_CHARS);
  const identity = readBlock(record.identity, MAX_IDENTITY_CHARS);
  if (!name || !identity) return null;

  const memories: BotPersonaDraftMemory[] = [];
  if (Array.isArray(record.memories)) {
    for (const item of record.memories) {
      if (memories.length >= BOT_PERSONA_DRAFT_MAX_MEMORIES) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const memory = item as Record<string, unknown>;
      const title = readLine(memory.title, MAX_MEMORY_TITLE_CHARS);
      const description = readLine(memory.description, MAX_MEMORY_DESCRIPTION_CHARS);
      if (!title || !description) continue;
      const body = readBlock(memory.body, MAX_MEMORY_BODY_CHARS) || description;
      memories.push({ title, description, body });
    }
  }

  return {
    name,
    description: readLine(record.description, MAX_DESCRIPTION_CHARS),
    identity,
    // 开场白是可选的:拿不到就由 renderer 回落到带名字的模板句。
    greeting: readBlock(record.greeting, MAX_GREETING_CHARS),
    style: pickEnum(record.style, BOT_PERSONA_DRAFT_STYLES, 'concise'),
    proactivity: pickEnum(record.proactivity, BOT_PERSONA_DRAFT_PROACTIVITIES, 'reactive'),
    call: pickEnum(record.call, BOT_PERSONA_DRAFT_CALLS, 'name'),
    avatarPreset: readLine(record.avatarPreset, 32).toLowerCase(),
    avatarHue: readLine(record.avatarHue, 32).toLowerCase(),
    memories,
  };
}
