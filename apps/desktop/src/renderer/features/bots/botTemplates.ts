export type BotTemplateId = 'programmer' | 'designer' | 'counsel';
export const CUSTOM_BOT_TEMPLATE_ID = 'custom' as const;
export type BotTemplateChoiceId = BotTemplateId | typeof CUSTOM_BOT_TEMPLATE_ID;

export interface BotTemplateDefinition<TId extends BotTemplateChoiceId = BotTemplateChoiceId> {
  id: TId;
  avatar: string;
  avatarColor: 'violet' | 'blue' | 'amber';
  identitySource: string;
  translationKey: TId;
}

/**
 * A template is only a starting draft for the same profile editor used
 * everywhere else. Runtime/model/permission choices deliberately stay out of
 * templates so choosing a role never silently changes host settings.
 */
export const BOT_TEMPLATES: readonly BotTemplateDefinition<BotTemplateId>[] = [
  {
    id: 'programmer',
    avatar: '💻',
    avatarColor: 'blue',
    translationKey: 'programmer',
    identitySource: [
      '你是 Cindy 中负责软件开发的长期协作伙伴。你可以协助代码实现、架构分析、问题排查、部署和交付验证。',
      '开始前先确认目标和约束，保持改动范围清晰；完成后验证结果，并如实说明尚未验证的部分。发现范围外的问题可以指出，但不要擅自扩大改动。',
      '表达应专业、直接、具体。需要交付方案、说明或评审记录时，优先生成可继续使用的文件。',
    ].join('\n\n'),
  },
  {
    id: 'designer',
    avatar: '🎨',
    avatarColor: 'violet',
    translationKey: 'designer',
    identitySource: [
      '你是 Cindy 中负责设计支持的长期协作伙伴。你可以协助界面、演示文稿、排版和视觉表达。',
      '开始前先确认受众、使用场景和交付媒介；需要探索时提供少量有明确差异的方案，并说明各自取舍。完成后检查信息层级、对齐、留白和一致性。',
      '表达应专业、清楚、克制，避免只用主观形容词代替设计依据。',
    ].join('\n\n'),
  },
  {
    id: 'counsel',
    avatar: '⚖️',
    avatarColor: 'amber',
    translationKey: 'counsel',
    identitySource: [
      '你是 Cindy 中负责法务支持的长期协作伙伴。你可以协助合同、条款、合规事项和风险的初步审查。',
      '先给出结论和风险等级，再说明依据并提供可执行的修改建议。对不确定或受司法辖区影响的事项应明确标注，并建议交由具备资质的专业人士确认。',
      '你的工作不构成正式法律意见。表达应严谨、清楚，不把不确定判断说成事实。',
    ].join('\n\n'),
  },
] as const;

export const CUSTOM_BOT_TEMPLATE: BotTemplateDefinition<typeof CUSTOM_BOT_TEMPLATE_ID> = {
  id: CUSTOM_BOT_TEMPLATE_ID,
  avatar: '✦',
  avatarColor: 'amber',
  translationKey: CUSTOM_BOT_TEMPLATE_ID,
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
