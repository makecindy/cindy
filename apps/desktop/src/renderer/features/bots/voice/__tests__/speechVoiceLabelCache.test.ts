// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { readSpeechVoiceLabel, rememberSpeechVoiceLabel } from '../speechVoiceLabelCache';

beforeEach(() => {
  window.localStorage.clear();
  setDataOwnerGeneration('account-a', 1);
});
afterEach(() => vi.restoreAllMocks());

it('restores persisted display metadata only for the same account, companion, route and full ID', () => {
  const owner = getDataOwnerGeneration();
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'River');
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBe('River');
  expect(readSpeechVoiceLabel(owner, 'other-bot', 'route', 'voice')).toBeUndefined();
  expect(readSpeechVoiceLabel(owner, 'bot', 'other-route', 'voice')).toBeUndefined();
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'other-voice')).toBeUndefined();
  setDataOwnerGeneration('account-b', 2);
  expect(readSpeechVoiceLabel(getDataOwnerGeneration(), 'bot', 'route', 'voice')).toBeUndefined();
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'Late old account result');
  setDataOwnerGeneration('account-a', 3);
  const resumed = getDataOwnerGeneration();
  expect(readSpeechVoiceLabel(resumed, 'bot', 'route', 'voice')).toBe('River');
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'Late old generation result');
  expect(readSpeechVoiceLabel(resumed, 'bot', 'route', 'voice')).toBe('River');
});

it('updates or removes an exact label without modifying other selections', () => {
  const owner = getDataOwnerGeneration();
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'River');
  rememberSpeechVoiceLabel(owner, 'other-bot', 'route', 'voice', 'Other');
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'River Updated');
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBe('River Updated');
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', undefined);
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBeUndefined();
  expect(readSpeechVoiceLabel(owner, 'other-bot', 'route', 'voice')).toBe('Other');
});

it('bounds display-only storage and recovers from a corrupt cache', () => {
  const owner = getDataOwnerGeneration();
  for (let index = 0; index < 65; index++)
    rememberSpeechVoiceLabel(owner, `bot-${index}`, 'route', 'voice', 'River');
  expect(readSpeechVoiceLabel(owner, 'bot-0', 'route', 'voice')).toBeUndefined();
  expect(readSpeechVoiceLabel(owner, 'bot-64', 'route', 'voice')).toBe('River');
  const key = window.localStorage.key(0)!;
  window.localStorage.setItem(key, 'broken json');
  expect(readSpeechVoiceLabel(owner, 'bot-64', 'route', 'voice')).toBeUndefined();
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'Recovered');
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBe('Recovered');
  rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'x'.repeat(513));
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBe('Recovered');
});

it('does not write an unscoped cache or fail when local storage is unavailable', () => {
  setDataOwnerGeneration(null, 2);
  rememberSpeechVoiceLabel(getDataOwnerGeneration(), 'bot', 'route', 'voice', 'River');
  expect(window.localStorage.length).toBe(0);
  setDataOwnerGeneration('account-a', 3);
  const owner = getDataOwnerGeneration();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => rememberSpeechVoiceLabel(owner, 'bot', 'route', 'voice', 'River')).not.toThrow();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('unavailable');
  });
  expect(readSpeechVoiceLabel(owner, 'bot', 'route', 'voice')).toBeUndefined();
});
