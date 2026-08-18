import type { BotAvatarHue } from './BotAvatar';
// Imported from the leaf module, not from BotAvatar.tsx: this file is also loaded
// by plain-Node tooling that cannot resolve the bundled portrait asset.
import { CINDY_OFFICIAL_AVATAR, presetAvatarValue } from './botAvatarIdentity';
import { NEW_BOT_DEFAULT_PERMISSIONS } from './botCapabilityDefaults';
import type { BotCapabilities } from './botStore';

/**
 * The shipped roster. Ids are the characters themselves, not the job title they
 * grew out of: a user picks "本本", not "the PR steward template". The capability
 * shape each one inherits is noted on its definition.
 */
export type BotTemplateId = 'cindy' | 'shiba' | 'melody' | 'butler' | 'star' | 'ashu';
/** Template cards shown in the create dialog: the roster + a blank one. */
export type BotTemplateChoiceId = BotTemplateId | 'custom';

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
}

const ASSISTANT_CAPABILITIES: Partial<BotCapabilities> = {
  harness: 'claude',
  automation: false,
  sessionControlMode: 'none',
  permissions: NEW_BOT_DEFAULT_PERMISSIONS,
};

const COORDINATOR_CAPABILITIES: Partial<BotCapabilities> = {
  harness: 'claude',
  automation: true,
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
  },
] as const;

export function getBotTemplate(id: BotTemplateId): BotTemplateDefinition {
  return BOT_TEMPLATES.find((template) => template.id === id) ?? BOT_TEMPLATES[0];
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
