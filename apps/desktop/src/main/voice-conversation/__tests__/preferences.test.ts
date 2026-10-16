import { expect, it } from 'vitest';
import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import {
  companionVoicePreference,
  updateCompanionVoicePreference,
  updateSentencePlaybackPreference,
} from '../preferences.js';
const a = { providerId: 'a', agent: 'codex' as const, modelId: 'tts', voice: 'alloy' };
const b = { ...a, providerId: 'b', voice: 'nova' };
it('persists each companion independently, preserves legacy inheritance, and deletes only a reset override', () => {
  let settings = normalizeVoiceInputSettings({
    conversationSelection: { modelId: 'old', voice: 'alloy' },
  });
  const update = (id: string, value: typeof a | null) => {
    settings = normalizeVoiceInputSettings({
      ...settings,
      conversationSelections: updateCompanionVoicePreference(settings, id, value),
    });
  };
  update('bot-a', a);
  update('bot-b', b);
  settings = normalizeVoiceInputSettings(JSON.parse(JSON.stringify(settings)));
  expect(companionVoicePreference(settings, 'bot-a')).toEqual({
    selection: a,
    customized: true,
    sentencePlayback: true,
  });
  expect(companionVoicePreference(settings, 'bot-b')).toEqual({
    selection: b,
    customized: true,
    sentencePlayback: true,
  });
  update('bot-a', null);
  expect(settings.conversationSelections!['bot-a']).toBeNull();
  expect(companionVoicePreference(settings, 'bot-a')).toEqual({
    selection: null,
    customized: false,
    sentencePlayback: true,
  });
  expect(companionVoicePreference(settings, 'bot-b').selection).toEqual(b);
  expect(companionVoicePreference(normalizeVoiceInputSettings({}), 'bot-b')).toEqual({
    selection: null,
    customized: false,
    sentencePlayback: true,
  });
});
it('does not read prototype keys or retain malformed saved choices', () => {
  const settings = normalizeVoiceInputSettings({
    conversationSelections: { invalid: { modelId: 'tts', voice: '/' }, valid: a },
  });
  expect(companionVoicePreference(settings, 'toString').selection).toBe(null);
  expect(Object.keys(settings.conversationSelections!)).toEqual(['valid']);
});

it('defaults to sentence playback, keeps explicit choices across reloads and resets only one companion', () => {
  let settings = normalizeVoiceInputSettings({ conversationSelections: { 'bot-a': a } });
  expect(settings.conversationSentencePlayback).toBeUndefined();
  expect(companionVoicePreference(settings, 'bot-a').sentencePlayback).toBe(true);
  const update = (botId: string, enabled: boolean | null) => {
    settings = normalizeVoiceInputSettings({
      ...settings,
      conversationSentencePlayback: updateSentencePlaybackPreference(settings, botId, enabled),
    });
  };
  update('bot-a', false);
  update('bot-b', true);
  settings = normalizeVoiceInputSettings(JSON.parse(JSON.stringify(settings)));
  expect(companionVoicePreference(settings, 'bot-a')).toMatchObject({
    selection: a,
    sentencePlayback: false,
  });
  expect(companionVoicePreference(settings, 'bot-b')).toMatchObject({
    customized: true,
    sentencePlayback: true,
  });
  update('bot-a', null);
  expect(settings.conversationSentencePlayback).toEqual({ 'bot-b': true });
  expect(companionVoicePreference(settings, 'bot-a').sentencePlayback).toBe(true);
  expect(companionVoicePreference(settings, 'toString').sentencePlayback).toBe(true);
  expect(
    normalizeVoiceInputSettings({ conversationSentencePlayback: { bad: 'false', valid: false } })
      .conversationSentencePlayback,
  ).toEqual({ valid: false });
});
