import { expect, it } from 'vitest';
import type { Catalog, ProviderMediaModel } from '@cindy/model-providers';
import { speechModels } from '../models.js';
import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';

const model = (id: string, extra: Partial<ProviderMediaModel> = {}): ProviderMediaModel => ({
  id,
  name: id,
  mode: 'audio_speech',
  availability: 'available',
  ...extra,
});
it('offers only available, enabled Gateway speech models with a supported protocol', () => {
  const catalog = {
    providers: [
      {
        id: 'xd',
        audioModels: [
          model('new-speech'),
          model('paid', { availability: 'requires_payment' }),
          model('registry-only', { availability: undefined }),
          model('disabled', { disabled: true }),
          model('override'),
          model('asr', { mode: 'audio_transcription' }),
          model('wrong-protocol', { nativeApi: 'openai-responses' }),
          model('unverified', { nativeApi: null }),
        ],
      },
      { id: 'other', audioModels: [model('other-speech')] },
    ],
  } as unknown as Catalog;
  expect(speechModels(catalog, true, (id) => id === 'override')).toEqual([
    { id: 'new-speech', name: 'new-speech' },
  ]);
  expect(speechModels(catalog, false, () => false)).toEqual([]);
});

it('does not pin a default speech model and lets null reset an explicit preference', () => {
  expect(normalizeVoiceInputSettings({}).conversationSelection).toBeUndefined();
  expect(
    normalizeVoiceInputSettings({ conversationSelection: { modelId: 'tts', voice: 'alloy' } })
      .conversationSelection,
  ).toEqual({ modelId: 'tts', voice: 'alloy' });
  expect(
    normalizeVoiceInputSettings({ conversationSelection: null }).conversationSelection,
  ).toBeUndefined();
  expect(
    normalizeVoiceInputSettings({ conversationSelection: { modelId: 'tts', voice: 'bad\nvoice' } })
      .conversationSelection,
  ).toBeUndefined();
});
