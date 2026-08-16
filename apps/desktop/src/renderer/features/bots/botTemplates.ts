import type { BotCapabilities } from './botStore';

export type BotTemplateId = 'control' | 'pr-steward' | 'assistant';

export interface BotTemplateDefinition {
  id: BotTemplateId;
  avatar: string;
  avatarColor: 'violet' | 'blue' | 'amber' | 'graphite';
  nameKey: string;
  descriptionKey: string;
  identitySource: string;
  capabilities: Partial<BotCapabilities>;
  autoSubscribeToTaskEvents: boolean;
}

/**
 * Hermes-compatible profile templates.
 *
 * These strings are SOUL material only: durable role, temperament and scope.
 * User facts belong in USER context; Skills/MCPs/tools, task control, Channels,
 * Automation and event subscriptions remain structured Profile/runtime state.
 */
export const BOT_TEMPLATES: readonly BotTemplateDefinition[] = [
  {
    id: 'control',
    avatar: '🧭',
    avatarColor: 'violet',
    nameKey: 'bots.createWizard.templates.control.defaultName',
    descriptionKey: 'bots.createWizard.templates.control.defaultDescription',
    identitySource: [
      'You are a persistent Cindy control assistant.',
      'Your enduring responsibility is to keep ongoing work connected: notice meaningful state changes, inspect the current facts, coordinate the next safe action, and give concise progress or decision reports.',
      'Respect the owner of every task, preserve explicit decisions, and surface uncertainty instead of inventing completion.',
    ].join('\n\n'),
    capabilities: {
      harness: 'claude',
      automation: true,
      sessionControlMode: 'coordinate',
      permissions: 'ask',
    },
    autoSubscribeToTaskEvents: true,
  },
  {
    id: 'pr-steward',
    avatar: '🛠️',
    avatarColor: 'blue',
    nameKey: 'bots.createWizard.templates.prSteward.defaultName',
    descriptionKey: 'bots.createWizard.templates.prSteward.defaultDescription',
    identitySource: [
      'You are a persistent pull-request delivery steward in Cindy.',
      'Your enduring responsibility is to track delivery state, identify actionable review or check failures, coordinate the owning task, and report the smallest truthful next step.',
      'Do not claim merge, release, deployment, or real-world verification without current evidence.',
    ].join('\n\n'),
    capabilities: {
      harness: 'claude',
      automation: true,
      sessionControlMode: 'coordinate',
      permissions: 'ask',
    },
    autoSubscribeToTaskEvents: true,
  },
  {
    id: 'assistant',
    avatar: '✦',
    avatarColor: 'amber',
    nameKey: 'bots.createWizard.templates.assistant.defaultName',
    descriptionKey: 'bots.createWizard.templates.assistant.defaultDescription',
    identitySource: [
      'You are a persistent Cindy assistant.',
      "Be helpful, knowledgeable, direct, and honest about uncertainty. Carry the user's work forward while keeping explanations proportionate to the task.",
    ].join('\n\n'),
    capabilities: {
      harness: 'claude',
      automation: false,
      sessionControlMode: 'none',
      permissions: 'ask',
    },
    autoSubscribeToTaskEvents: false,
  },
] as const;

export function getBotTemplate(id: BotTemplateId): BotTemplateDefinition {
  return BOT_TEMPLATES.find((template) => template.id === id) ?? BOT_TEMPLATES[0];
}
