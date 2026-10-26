import { alibabaSystemVoices } from './alibabaSpeechVoices.js';
import type { SpeechProtocol, SpeechVoice } from './voiceConversation.js';

// Public reference data only. Caller must already have resolved the Cindy AI
// Gateway route; these IDs do not declare model access or an execution protocol.
// Official replacements for Default voices retiring on 2026-12-31:
// https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices
// IDs/names verified with /v1/shared-voices on 2026-10-22. Do not include private clones.
const GATEWAY_ELEVENLABS: readonly SpeechVoice[] = [
  { id: 'OZ0L6eISlOejga3XjDFt', name: 'Talia - Warm Soft Guide' },
  { id: 'gOupLcAkjEnguROwi4oS', name: 'Darian - Warm Grounded Storyteller' },
  { id: '6WwXjDDEMyNmFG95zycZ', name: 'Eldrin - Crisp British Baritone' },
  { id: 'dvbL7qkNGZY1IqPGZAjM', name: 'Elowen - Upbeat Modern Narrator' },
];

// Candidates from the official system list, not Gateway-verified voices:
// https://platform.minimax.io/docs/faq/system-voice-id
const GATEWAY_MINIMAX: readonly SpeechVoice[] = [
  { id: 'Chinese (Mandarin)_Warm_HeartedGirl', name: 'Warm-hearted Girl' },
  { id: 'Chinese (Mandarin)_Reliable_Executive', name: 'Reliable Executive' },
  { id: 'English_CalmWoman', name: 'Calm Woman' },
  { id: 'English_Trustworth_Man', name: 'Trustworthy Man' },
];

// Qwen-Audio 3.1 Plus system voices, verified through Gateway /v1/audio/speech
// with 24 kHz PCM on 2026-10-23. These are not Qwen3-TTS or 3.0 voice aliases.
// https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
const GATEWAY_QWEN_AUDIO_31_PLUS: readonly SpeechVoice[] = [
  { id: 'longanlingxin_v3.1', name: '龙安灵心_v3.1' },
  { id: 'xunanchuan_v3.1', name: '许南川' },
  { id: 'longanhuan_v3.1', name: '龙安欢_v3.1' },
  { id: 'longanfengyue_v3.1', name: '龙安风悦_v3.1' },
];

export function gatewayReferenceSpeechVoices(modelId: string): readonly SpeechVoice[] {
  if (['elevenlabs/eleven_multilingual_v2', 'elevenlabs/eleven_v3'].includes(modelId))
    return GATEWAY_ELEVENLABS;
  if (modelId === 'qwen/qwen-audio-3.1-tts-plus') return GATEWAY_QWEN_AUDIO_31_PLUS;
  // Exact documented versions, including their Gateway namespace. Unknown/new
  // models stay manual until their voice contract has been checked.
  if (/^minimax\/speech-(?:2\.[68]|0[12])-(?:hd|turbo)$/.test(modelId)) return GATEWAY_MINIMAX;
  return [];
}

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
  if (protocol === 'qwen-tts' || protocol === 'dashscope-tts')
    return alibabaSystemVoices(modelId, protocol).map(({ id }) => id);
  if (protocol !== 'openai') return [];
  if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return EXPRESSIVE;
  if (/^tts-1(?:-hd)?(?:-1106)?$/.test(modelId)) return STANDARD;
  return [];
}
