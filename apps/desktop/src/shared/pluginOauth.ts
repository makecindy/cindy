import type {
  PluginOauthAction,
  PluginSecretPresentation,
  PluginConnectionPresentation,
  PluginConnectionInput,
  InputHandoffPresentation,
  InputHandoffSubmission,
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

/** 代输入 step for a task on another computer; `ghostId` is INPUT_HANDOFF_GHOST_ID. */
export interface LocalInputHandoffRequest extends LocalPluginOauthRequest {
  submission: InputHandoffSubmission;
  presentation: InputHandoffPresentation;
}

/** 代输入 screenshot step on another computer: opens its sealed picture for this window. */
export interface LocalInputHandoffPictureRequest extends LocalPluginOauthRequest {
  presentation: InputHandoffPresentation;
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
