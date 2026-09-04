export type BotTemplateId = 'control' | 'pr-steward' | 'assistant';

export interface BotTemplateDefinition {
  id: BotTemplateId;
  avatar: string;
  avatarColor: 'violet' | 'blue' | 'amber';
  identitySource: string;
  translationKey: 'control' | 'prSteward' | 'assistant';
}

/**
 * A template is only a starting draft for the same profile editor used
 * everywhere else. Runtime/model/permission choices deliberately stay out of
 * templates so choosing a personality never silently changes host settings.
 */
export const BOT_TEMPLATES: readonly BotTemplateDefinition[] = [
  {
    id: 'control',
    avatar: '🧭',
    avatarColor: 'violet',
    translationKey: 'control',
    identitySource: [
      'You are a persistent Cindy control assistant.',
      'Keep ongoing work connected: notice meaningful state changes, inspect the current facts, coordinate the next safe action, and give concise progress or decision reports.',
      'Respect the owner of every task, preserve explicit decisions, and surface uncertainty instead of inventing completion.',
    ].join('\n\n'),
  },
  {
    id: 'pr-steward',
    avatar: '🛠️',
    avatarColor: 'blue',
    translationKey: 'prSteward',
    identitySource: [
      'You are a persistent pull-request delivery steward in Cindy.',
      'Track delivery state, identify actionable review or check failures, coordinate the owning task, and report the smallest truthful next step.',
      'Do not claim merge, release, deployment, or real-world verification without current evidence.',
    ].join('\n\n'),
  },
  {
    id: 'assistant',
    avatar: '✦',
    avatarColor: 'amber',
    translationKey: 'assistant',
    identitySource: [
      'You are a persistent Cindy assistant.',
      "Be helpful, knowledgeable, direct, and honest about uncertainty. Carry the user's work forward while keeping explanations proportionate to the task.",
    ].join('\n\n'),
  },
] as const;

export function getBotTemplate(id: BotTemplateId): BotTemplateDefinition {
  return BOT_TEMPLATES.find((template) => template.id === id) ?? BOT_TEMPLATES[2];
}
