import type { PiModelApi } from '@cindy/model-providers';

// Official API names stay recognizable across languages (see i18n/GLOSSARY.md).
export const MODEL_PROTOCOL_LABEL: Readonly<Record<PiModelApi, string>> = {
  'anthropic-messages': 'Messages',
  'openai-responses': 'Responses',
  'openai-completions': 'Chat Completions',
  'google-generative-ai': 'Google Gemini',
};
