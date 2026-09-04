import {
  BOT_TEMPLATE_PRESET_AVATARS,
  BOT_TEMPLATE_PRESET_IDENTITIES,
  type BotTemplatePresetId,
} from '../../../shared/botTemplatePreset';

export type BotTemplateId = BotTemplatePresetId;
export const CUSTOM_BOT_TEMPLATE_ID = 'custom' as const;
export type BotTemplateChoiceId = BotTemplateId | typeof CUSTOM_BOT_TEMPLATE_ID;

export interface BotTemplateDefinition<TId extends BotTemplateChoiceId = BotTemplateChoiceId> {
  id: TId;
  avatar: string;
  avatarColor: 'violet' | 'blue' | 'amber';
  identitySource: string;
  toolsets: readonly string[];
  translationKey: TId;
}

/**
 * 预设不只是几段表单文案，而是用户明确选择的一套初始身份与能力。模型和权限仍
 * 沿用全局默认；工作方法由 main 在创建时写进伙伴自己的 Skill 目录。
 */
export const BOT_TEMPLATES: readonly BotTemplateDefinition<BotTemplateId>[] = [
  {
    id: 'cindy',
    avatar: BOT_TEMPLATE_PRESET_AVATARS.cindy,
    avatarColor: 'blue',
    translationKey: 'cindy',
    toolsets: ['docs'],
    identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.cindy,
  },
  {
    id: 'dash',
    avatar: BOT_TEMPLATE_PRESET_AVATARS.dash,
    avatarColor: 'violet',
    translationKey: 'dash',
    toolsets: ['docs'],
    identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.dash,
  },
  {
    id: 'lizi',
    avatar: BOT_TEMPLATE_PRESET_AVATARS.lizi,
    avatarColor: 'amber',
    translationKey: 'lizi',
    toolsets: ['docs'],
    identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.lizi,
  },
] as const;

export const CUSTOM_BOT_TEMPLATE: BotTemplateDefinition<typeof CUSTOM_BOT_TEMPLATE_ID> = {
  id: CUSTOM_BOT_TEMPLATE_ID,
  avatar: '✦',
  avatarColor: 'amber',
  translationKey: CUSTOM_BOT_TEMPLATE_ID,
  toolsets: [],
  identitySource: [
    '你是 Cindy 中由用户自定义职责的长期协作伙伴。按照个人资料中定义的职责和协作方式工作。',
    '保持专业、直接，并如实说明不确定性。完成工作后验证结果，再向用户汇报。',
  ].join('\n\n'),
};

export const BOT_TEMPLATE_CHOICES: readonly BotTemplateDefinition[] = [
  ...BOT_TEMPLATES,
  CUSTOM_BOT_TEMPLATE,
];

export function getBotTemplate(id: BotTemplateId): BotTemplateDefinition<BotTemplateId> {
  return BOT_TEMPLATES.find((template) => template.id === id) ?? BOT_TEMPLATES[0];
}

export function getBotTemplateChoice(id: BotTemplateChoiceId): BotTemplateDefinition {
  return BOT_TEMPLATE_CHOICES.find((template) => template.id === id) ?? BOT_TEMPLATES[0];
}
