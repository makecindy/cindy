import { compatibilityProtocol } from '@cindy/model-compat/protocol';
import { PI_MODEL_APIS, type PiModelApi } from '@cindy/model-providers';

const labels = { anthropic: 'Messages', 'openai-responses': 'Responses', 'openai-chat': 'Chat Completions', google: 'Google Gemini' };
// Platform adapters do not become additional user-facing API languages.
export const MODEL_PROTOCOL_LABEL: Readonly<Partial<Record<PiModelApi, string>>> = Object.fromEntries(
  PI_MODEL_APIS.flatMap(api => { const protocol = compatibilityProtocol(api); return protocol ? [[api, labels[protocol]]] : []; }),
);
export const MODEL_PROTOCOL_OPTIONS = [
  ['anthropic-messages', labels.anthropic], ['openai-responses', labels['openai-responses']],
  ['openai-completions', labels['openai-chat']], ['google-generative-ai', labels.google],
] as const;
