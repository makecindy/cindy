import type { BotAvatarHue } from './BotAvatar';
// Imported from the leaf module, not from BotAvatar.tsx: this file is also loaded
// by plain-Node tooling that cannot resolve the bundled portrait asset.
import { CINDY_OFFICIAL_AVATAR, presetAvatarValue } from './botAvatarIdentity';
import { NEW_BOT_DEFAULT_PERMISSIONS } from './botCapabilityDefaults';
import { BOT_AUTOMATION_DEFAULT } from '../../../shared/botAutomationCapability';
import type { BotMemorySeedEntry, BotMemorySeedType } from '../../../shared/botMemorySeed';
import type { BotCapabilities } from './botStore';

/**
 * The shipped roster. Ids are the characters themselves, not the job title they
 * grew out of: a user picks "本本", not "the PR steward template". The capability
 * shape each one inherits is noted on its definition.
 */
export type BotTemplateId = 'cindy' | 'shiba' | 'melody' | 'butler' | 'star' | 'ashu';
/** Template cards shown in the create dialog: the roster + a blank one. */
export type BotTemplateChoiceId = BotTemplateId | 'custom';

/**
 * 一条「初始记忆」的模板定义。
 *
 * 内容是**这个角色自己的开场笔记** —— 它怎么汇报、把改动做多小、先确认什么。
 * 刻意**不写**任何关于主人的事(「主人喜欢被提醒喝水」这类):模板不认识用户,
 * 把编出来的偏好写进「TA 记得的」等于让伙伴一上来就撒一个用户看得见的谎。
 * 同一条边界在 `identitySource` 上已经成立(userContextSource 恒为空),这里沿用。
 *
 * 文案走 i18n(五语言),`slug` 是文件名兼幂等键,不进翻译。
 */
export interface BotTemplateSeedMemory {
  /** `[a-z0-9-]`,同时是幂等键。 */
  slug: string;
  type: BotMemorySeedType;
  titleKey: string;
  descriptionKey: string;
  bodyKey: string;
}

export interface BotTemplateDefinition {
  id: BotTemplateId;
  avatar: string;
  avatarColor: BotAvatarHue;
  nameKey: string;
  /** One-liner stored on the profile ("你的贴身助理"). */
  descriptionKey: string;
  /** The "擅长 · X" label on the roster card. */
  skillKey: string;
  /** First-person self-introduction printed on the roster card. */
  introKey: string;
  /**
   * What this teammate says by itself the first time its canonical chat opens.
   * Persisted as a real assistant message — see `botWelcome.ts`.
   */
  welcomeKey: string;
  identitySource: string;
  capabilities: Partial<BotCapabilities>;
  autoSubscribeToTaskEvents: boolean;
  /**
   * 加入时写进这个伙伴记忆空间的开场笔记(0-2 条)。落地走
   * `window.electronAPI.maker.botMemory.seed`,按 slug 幂等,用户随后可以逐条删。
   */
  seedMemories: readonly BotTemplateSeedMemory[];
}

function seedMemory(
  id: BotTemplateId,
  slug: string,
  type: BotMemorySeedType = 'reference',
): BotTemplateSeedMemory {
  const base = `${copyKey(id, 'seedMemories')}.${slug.replace(/-/g, '_')}`;
  return {
    slug,
    type,
    titleKey: `${base}.title`,
    descriptionKey: `${base}.description`,
    bodyKey: `${base}.body`,
  };
}

/*
  `automation` 两档模板都写 `true` —— 定时干活是标配(裁决 2026-08-19),
  开关面已下线,读取侧也统一由 normalizeBotAutomation 归一。

  `sessionControlMode` 仍然分档,而且**刻意保留差异**:它不是「能不能被召唤」
  (协作是标配,委派链路从不查它),而是「TA 主动去动别的任务的权限」。
  阿枢 / 本本要订阅并处理其它任务的事件,所以是 coordinate;其余伙伴保持
  none,不往 system 段塞用不上的任务控制说明。用户可见的那个下拉已经移除。
*/
/**
 * 普通伙伴的能力基线。导出是为了给「AI 角色生成」用:生成出来的伙伴不属于任何
 * 模板,但它的能力配置不该另起一套 —— 和阵容里的普通助理一模一样就对了。
 */
export const ASSISTANT_BASELINE_CAPABILITIES: Partial<BotCapabilities> = {
  harness: 'claude',
  automation: BOT_AUTOMATION_DEFAULT,
  sessionControlMode: 'none',
  permissions: NEW_BOT_DEFAULT_PERMISSIONS,
};

const ASSISTANT_CAPABILITIES = ASSISTANT_BASELINE_CAPABILITIES;

const COORDINATOR_CAPABILITIES: Partial<BotCapabilities> = {
  harness: 'claude',
  automation: BOT_AUTOMATION_DEFAULT,
  sessionControlMode: 'coordinate',
  permissions: NEW_BOT_DEFAULT_PERMISSIONS,
};

function copyKey(id: BotTemplateId, leaf: string): string {
  return `bots.createWizard.templates.${id}.${leaf}`;
}

/**
 * Hermes-compatible profile templates.
 *
 * `identitySource` is SOUL material only: durable role, temperament and scope.
 * User facts belong in USER context; Skills/MCPs/tools, task control, Channels,
 * Automation and event subscriptions remain structured Profile/runtime state.
 * The first line carries the character's own voice (the same voice the roster
 * card shows the user), the rest states the durable responsibility in English so
 * the model reads one consistent brief.
 */
export const BOT_TEMPLATES: readonly BotTemplateDefinition[] = [
  {
    // The standard assistant *is* Cindy, so she ships with the official mark and
    // the brand name. The hue behind it only shows while the image decodes.
    id: 'cindy',
    avatar: CINDY_OFFICIAL_AVATAR,
    avatarColor: 'graphite',
    nameKey: copyKey('cindy', 'name'),
    descriptionKey: copyKey('cindy', 'description'),
    skillKey: copyKey('cindy', 'skill'),
    introKey: copyKey('cindy', 'intro'),
    welcomeKey: copyKey('cindy', 'welcome'),
    identitySource: [
      '你是 Cindy。工作生活里的杂事都可以丢给你——写东西、查资料、盯日程、看消息。语气轻松、主动，需要时才开口。',
      'You are a persistent Cindy assistant.',
      "Be helpful, knowledgeable, direct, and honest about uncertainty. Carry the user's work forward while keeping explanations proportionate to the task.",
    ].join('\n\n'),
    capabilities: ASSISTANT_CAPABILITIES,
    autoSubscribeToTaskEvents: false,
    seedMemories: [seedMemory('cindy', 'ask-before-guessing')],
  },
  {
    id: 'shiba',
    avatar: presetAvatarValue('shiba'),
    avatarColor: 'amber',
    nameKey: copyKey('shiba', 'name'),
    descriptionKey: copyKey('shiba', 'description'),
    skillKey: copyKey('shiba', 'skill'),
    introKey: copyKey('shiba', 'intro'),
    welcomeKey: copyKey('shiba', 'welcome'),
    identitySource: [
      '你是小柴，一只热心的柴犬管家。提醒、日程、代办、记账，家里的事都包在你身上。说话短、活泼，偶尔「汪」一声。',
      'You are a persistent everyday-life assistant in Cindy.',
      'Your enduring responsibility is the small recurring things: reminders, schedules, errands and simple records. Keep every reply short, confirm what you wrote down, and never invent an event the owner did not ask for.',
    ].join('\n\n'),
    capabilities: ASSISTANT_CAPABILITIES,
    autoSubscribeToTaskEvents: false,
    seedMemories: [
      seedMemory('shiba', 'one-thing-per-reminder'),
      seedMemory('shiba', 'read-back-what-i-wrote'),
    ],
  },
  {
    id: 'melody',
    avatar: presetAvatarValue('melody'),
    avatarColor: 'blue',
    nameKey: copyKey('melody', 'name'),
    descriptionKey: copyKey('melody', 'description'),
    skillKey: copyKey('melody', 'skill'),
    introKey: copyKey('melody', 'intro'),
    welcomeKey: copyKey('melody', 'welcome'),
    identitySource: [
      '你是 Melody，技术搭子。代码、部署、修 bug 找你。话不多，活很细：改动小、说明短、做完自己先跑一遍。',
      'You are a persistent engineering companion in Cindy.',
      'Your enduring responsibility is code, builds and defects. Keep changes small and reviewable, verify before reporting, and state what you did not verify instead of implying success.',
    ].join('\n\n'),
    capabilities: ASSISTANT_CAPABILITIES,
    autoSubscribeToTaskEvents: false,
    seedMemories: [seedMemory('melody', 'small-changes')],
  },
  {
    id: 'butler',
    avatar: presetAvatarValue('butler'),
    avatarColor: 'teal',
    nameKey: copyKey('butler', 'name'),
    descriptionKey: copyKey('butler', 'description'),
    skillKey: copyKey('butler', 'skill'),
    introKey: copyKey('butler', 'intro'),
    welcomeKey: copyKey('butler', 'welcome'),
    identitySource: [
      '你是本本，项目管家。流程你来盯：评审、检查、交付，主人只看结果。稳重周到，先讲清楚再动手，风险单独说。',
      'You are a persistent delivery steward in Cindy.',
      'Your enduring responsibility is to track delivery state, identify actionable review or check failures, coordinate the owning task, and report the smallest truthful next step.',
      'Do not claim merge, release, deployment, or real-world verification without current evidence.',
    ].join('\n\n'),
    capabilities: COORDINATOR_CAPABILITIES,
    autoSubscribeToTaskEvents: true,
    seedMemories: [seedMemory('butler', 'risks-said-separately')],
  },
  {
    id: 'star',
    avatar: presetAvatarValue('star'),
    avatarColor: 'pink',
    nameKey: copyKey('star', 'name'),
    descriptionKey: copyKey('star', 'description'),
    skillKey: copyKey('star', 'skill'),
    introKey: copyKey('star', 'intro'),
    welcomeKey: copyKey('star', 'welcome'),
    identitySource: [
      '你是星星，内容搭子。文案、配图、发帖子都归你，保证有网感。语气轻快，喜欢先给几版让主人挑。',
      'You are a persistent content companion in Cindy.',
      'Your enduring responsibility is drafting, illustrating and publishing copy. Offer options instead of one take, match the owner\'s voice, and check tone before anything goes out.',
    ].join('\n\n'),
    capabilities: ASSISTANT_CAPABILITIES,
    autoSubscribeToTaskEvents: false,
    seedMemories: [seedMemory('star', 'three-drafts-first')],
  },
  {
    id: 'ashu',
    avatar: presetAvatarValue('owl'),
    avatarColor: 'violet',
    nameKey: copyKey('ashu', 'name'),
    descriptionKey: copyKey('ashu', 'description'),
    skillKey: copyKey('ashu', 'skill'),
    introKey: copyKey('ashu', 'intro'),
    welcomeKey: copyKey('ashu', 'welcome'),
    identitySource: [
      '你是阿枢，总控。各处任务的动静你都盯着，出事你第一个知道，也第一个告诉主人。话直、克制，只报结论和要决定的事。',
      'You are a persistent Cindy control assistant.',
      'Your enduring responsibility is to keep ongoing work connected: notice meaningful state changes, inspect the current facts, coordinate the next safe action, and give concise progress or decision reports.',
      'Respect the owner of every task, preserve explicit decisions, and surface uncertainty instead of inventing completion.',
    ].join('\n\n'),
    capabilities: COORDINATOR_CAPABILITIES,
    autoSubscribeToTaskEvents: true,
    seedMemories: [seedMemory('ashu', 'conclusion-first')],
  },
] as const;

export function getBotTemplate(id: BotTemplateId): BotTemplateDefinition {
  return BOT_TEMPLATES.find((template) => template.id === id) ?? BOT_TEMPLATES[0];
}

/**
 * AI 生成路径写下的初始记忆用的 slug(见 `botPersonaSeedEntries`)。
 *
 * 它和模板 slug 一起构成「这条分片是加入时自带的」的判据 —— 设置页的脚注要靠它
 * 决定说哪一句:列表里一条自带的都没有时,说「有几条是 TA 加入时自带的」就是在
 * 对着一个空列表撒谎。
 */
export const GENERATED_SEED_SLUG_PATTERN = /^start-[1-9]\d*$/;

const TEMPLATE_SEED_SLUGS: ReadonlySet<string> = new Set(
  BOT_TEMPLATES.flatMap((template) => template.seedMemories.map((seed) => seed.slug)),
);

/** 这条记忆分片是不是「加入时自带的」。用户后来自己攒的记忆一律 false。 */
export function isBotSeedMemorySlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return TEMPLATE_SEED_SLUGS.has(normalized) || GENERATED_SEED_SLUG_PATTERN.test(normalized);
}

/**
 * 按显示名反查模板。
 *
 * Bot Profile 不存模板 id —— 阵容页判断「这张卡已加入」用的也是同一个口径(名字)。
 * 用途仅限「这个伙伴本该带哪几条开场笔记」,拿不准就返回 null,宁可不提供补写入口
 * 也不给一个伙伴塞别人的笔记。用户把伙伴改了名之后这里查不到,补写入口随之消失 ——
 * 那是可以接受的:它本来就是一条兜底路径,不是主功能。
 */
export function botTemplateForName(
  name: string,
  t: (key: string) => string,
): BotTemplateDefinition | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  return (
    BOT_TEMPLATES.find((template) => t(template.nameKey).trim().toLowerCase() === normalized) ?? null
  );
}

/**
 * 把模板的初始记忆翻成可以直接落库的分片。
 *
 * 取 `t` 而不是 i18n 实例:这是一个纯函数,单测里传一个恒等 `t` 就能钉住形状,
 * 不用起 i18next。翻不出内容(key 缺失时 i18next 会回吐 key 本身)照样写进去 ——
 * 那种情况是翻译缺失的 bug,由 `pnpm check:i18n` 拦,不在运行期悄悄少写一条。
 */
export function botTemplateSeedEntries(
  template: BotTemplateDefinition,
  t: (key: string) => string,
): BotMemorySeedEntry[] {
  return template.seedMemories.map((seed) => ({
    slug: seed.slug,
    type: seed.type,
    title: t(seed.titleKey),
    description: t(seed.descriptionKey),
    body: t(seed.bodyKey),
  }));
}

/**
 * The blank choice in the create dialog. It is deliberately NOT part of
 * `BOT_TEMPLATES`: it carries no identity, no capability opinion and no event
 * subscription, so it must never be reachable through `getBotTemplate`.
 */
export const CUSTOM_BOT_TEMPLATE_ID = 'custom' as const;

export function isBotTemplateId(id: BotTemplateChoiceId): id is BotTemplateId {
  return id !== CUSTOM_BOT_TEMPLATE_ID;
}

/** Card order in the create dialog: the roster in roster order, blank last. */
export const BOT_TEMPLATE_CHOICE_IDS: readonly BotTemplateChoiceId[] = [
  ...BOT_TEMPLATES.map((template) => template.id),
  CUSTOM_BOT_TEMPLATE_ID,
];
