import type { SpeechProtocol } from './voiceConversation.js';

// Model-specific reference lists, not a provider capability declaration. Compatible
// endpoints may expose a different set; manual IDs and a real preview remain available.
// https://developers.openai.com/api/docs/guides/text-to-speech#voice-options
const STANDARD = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const EXPRESSIVE = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];

export function referenceSpeechVoices(
  modelId: string,
  protocol?: SpeechProtocol,
): readonly string[] {
  if (protocol !== 'openai') return [];
  if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return EXPRESSIVE;
  if (/^tts-1(?:-hd)?(?:-1106)?$/.test(modelId)) return STANDARD;
  return [];
}
