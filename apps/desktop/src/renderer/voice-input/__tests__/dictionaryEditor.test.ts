import { describe, expect, it } from 'vitest';

import type { VoiceInputDictionaryEntry } from '../../../shared/voiceInputData';
import {
  formatVoiceInputDictionaryAliasDraft,
  parseVoiceInputDictionaryAliasDraft,
  voiceInputDictionaryEntryMatches,
} from '../dictionaryEditor';

const ENTRY: VoiceInputDictionaryEntry = {
  id: 'dict:vibe-coding',
  text: 'Vibe Coding',
  source: 'automatic',
  frequency: 4,
  aliases: [
    { text: 'web coding', count: 3, lastSeenAt: 3 },
    { text: 'vibe coating', count: 1, lastSeenAt: 4 },
  ],
  createdAt: 1,
  updatedAt: 4,
};

describe('voice dictionary editor', () => {
  it('formats aliases one per line for direct editing', () => {
    expect(formatVoiceInputDictionaryAliasDraft(ENTRY.aliases)).toBe('web coding\nvibe coating');
  });

  it('removes duplicate lines and excludes the term itself', () => {
    expect(
      parseVoiceInputDictionaryAliasDraft(
        ' web coding\nVibe Coding\nWEB CODING\n vibe coating ',
        'Vibe Coding',
      ),
    ).toEqual(['web coding', 'vibe coating']);
  });

  it('round-trips aliases containing commas and semicolons', () => {
    const aliases: VoiceInputDictionaryEntry['aliases'] = [
      { text: 'Smith, Jr.', count: 2, lastSeenAt: 3 },
      { text: 'ACME; Inc.', count: 1, lastSeenAt: 4 },
    ];
    expect(
      parseVoiceInputDictionaryAliasDraft(formatVoiceInputDictionaryAliasDraft(aliases), 'X'),
    ).toEqual(['Smith, Jr.', 'ACME; Inc.']);
  });

  it('searches both the term and its misrecognition aliases', () => {
    expect(voiceInputDictionaryEntryMatches(ENTRY, 'all', 'coating')).toBe(true);
    expect(voiceInputDictionaryEntryMatches(ENTRY, 'manual', 'coating')).toBe(false);
  });
});
