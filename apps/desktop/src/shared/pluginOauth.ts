import type {
  PluginOauthAction,
  PluginSecretPresentation,
  PluginConnectionPresentation,
  PluginConnectionInput,
} from '@cindy/device-link';
import type { GhostSetupInlineSecretField } from './ghost.js';

/** Trusted Desktop IPC only; these requests must never use generic device-link invoke. */
export interface LocalPluginOauthRequest extends PluginOauthAction {
  deviceId: string;
  ghostId: string;
}

export interface LocalPluginSecretRequest extends LocalPluginOauthRequest {
  value: string;
  presentation: PluginSecretPresentation;
}

export interface LocalPluginConnectionRequest extends LocalPluginOauthRequest {
  value: PluginConnectionInput;
  presentation: PluginConnectionPresentation;
}

export function createPluginConnectionPresentation(
  card: { ghost: { name: string }; intro?: string },
  step: { title: string; description: string; action?: { id: string } },
): PluginConnectionPresentation {
  const prefix = 'manage_connection:connection:';
  if (!step.action?.id.startsWith(prefix)) throw new Error('PLUGIN_CONNECTION_UNAVAILABLE');
  return {
    ghostName: card.ghost.name,
    title: step.title,
    description: step.description,
    intro: card.intro ?? '',
    connectionKey: step.action.id.slice(prefix.length),
  };
}

/** Both Hosts bind the same displayed fields; neither side may choose a vault key. */
export function createPluginSecretPresentation(
  card: { ghost: { name: string }; intro?: string },
  step: Pick<PluginSecretPresentation, 'title' | 'description'>,
  field: Pick<GhostSetupInlineSecretField, 'label' | 'description' | 'maxLength'>,
): PluginSecretPresentation {
  return {
    ghostName: card.ghost.name,
    title: step.title,
    description: step.description,
    intro: card.intro ?? '',
    fieldLabel: field.label,
    fieldDescription: field.description ?? '',
    maxLength: field.maxLength,
  };
}
