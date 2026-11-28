import { describe, expect, it } from 'vitest';

import {
  MAX_VOICE_INPUT_DICTIONARY_ENTRIES,
  createManualVoiceInputDictionaryEntry,
  mergeVoiceInputDictionaryCsvTerms,
  mergeVoiceInputDictionaryImportItems,
  parseVoiceInputDictionaryCsv,
  parseVoiceInputDictionaryImport,
  serializeVoiceInputDictionaryCsv,
  serializeVoiceInputDictionaryJson,
} from '../../../shared/voiceInputData.js';

describe('voice input dictionary CSV import', () => {
  it('parses a one-column CSV with quoted values', () => {
    const result = parseVoiceInputDictionaryCsv('Claude Code\n"OpenAI, Inc."\n\n"Vibe Coding"\n');

    expect(result).toEqual({
      ok: true,
      terms: ['Claude Code', 'OpenAI, Inc.', 'Vibe Coding'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('rejects rows with multiple non-empty columns', () => {
    expect(parseVoiceInputDictionaryCsv('Claude Code,Cloud Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('parses CRLF line endings', () => {
    expect(parseVoiceInputDictionaryCsv('Claude Code\r\nGPT\r\n')).toEqual({
      ok: true,
      terms: ['Claude Code', 'GPT'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseVoiceInputDictionaryCsv(String.fromCharCode(0xfeff) + 'Claude Code')).toEqual({
      ok: true,
      terms: ['Claude Code'],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });
  });

  it('rejects fields containing a NUL byte', () => {
    expect(parseVoiceInputDictionaryCsv('Claude\0Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('rejects characters after a closing quote', () => {
    expect(parseVoiceInputDictionaryCsv('"Claude"Code')).toEqual({
      ok: false,
      reason: 'invalidCsv',
    });
  });

  it('deduplicates rows and skips overlong terms', () => {
    const longTerm = 'x'.repeat(121);
    const result = parseVoiceInputDictionaryCsv(`Claude Code\nclaude code\n${longTerm}\n`);

    expect(result).toEqual({
      ok: true,
      terms: ['Claude Code'],
      duplicateRowCount: 1,
      skippedTooLongCount: 1,
    });
  });

  it('merges imported terms as manual entries and skips existing terms', () => {
    const existing = createManualVoiceInputDictionaryEntry('Claude Code');
    if (!existing) throw new Error('failed to create fixture dictionary entry');

    const result = mergeVoiceInputDictionaryCsvTerms([existing], ['Cloud Code', 'Claude Code']);

    expect(result.importedCount).toBe(1);
    expect(result.duplicateExistingCount).toBe(1);
    expect(result.capacitySkippedCount).toBe(0);
    expect(result.entries.map((entry) => entry.text)).toEqual(['Claude Code', 'Cloud Code']);
    expect(result.entries[1].source).toBe('manual');
  });

  it('does not exceed dictionary capacity', () => {
    const existing = Array.from({ length: MAX_VOICE_INPUT_DICTIONARY_ENTRIES }, (_, index) => {
      const entry = createManualVoiceInputDictionaryEntry(`term-${index}`);
      if (!entry) throw new Error('failed to create fixture dictionary entry');
      return entry;
    });

    const result = mergeVoiceInputDictionaryCsvTerms(existing, ['extra-term']);

    expect(result.importedCount).toBe(0);
    expect(result.capacitySkippedCount).toBe(1);
    expect(result.entries).toHaveLength(MAX_VOICE_INPUT_DICTIONARY_ENTRIES);
  });

  it('round-trips dictionary entries and aliases through JSON and CSV export/import', () => {
    const entryA = createManualVoiceInputDictionaryEntry('Vibe Coding');
    const entryB = createManualVoiceInputDictionaryEntry('OpenAI, Inc.');
    if (!entryA || !entryB) throw new Error('failed to create fixture entries');
    entryA.aliases = [
      { text: 'OpenAI, Inc.', count: 3, lastSeenAt: 100 },
      { text: 'A | B', count: 2, lastSeenAt: 100 },
      { text: '外博扣丁', count: 1, lastSeenAt: 90 },
    ];

    const json = serializeVoiceInputDictionaryJson([entryA, entryB], '2026-11-28T00:00:00.000Z');
    const parsedJson = parseVoiceInputDictionaryImport(json, 'dictionary.json');
    expect(parsedJson).toEqual({
      ok: true,
      format: 'json',
      items: [
        { text: 'Vibe Coding', aliases: ['OpenAI, Inc.', 'A | B', '外博扣丁'] },
        { text: 'OpenAI, Inc.', aliases: [] },
      ],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });

    const csv = serializeVoiceInputDictionaryCsv([entryA, entryB]);
    const parsedCsv = parseVoiceInputDictionaryImport(csv, 'dictionary.csv');
    expect(parsedCsv).toEqual({
      ok: true,
      format: 'csv',
      items: [
        { text: 'Vibe Coding', aliases: ['OpenAI, Inc.', 'A | B', '外博扣丁'] },
        { text: 'OpenAI, Inc.', aliases: [] },
      ],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });

    const merged = mergeVoiceInputDictionaryImportItems([], parsedCsv.ok ? parsedCsv.items : []);
    expect(merged.importedCount).toBe(2);
    expect(merged.entries[0]?.aliases.map((alias) => alias.text)).toEqual(['OpenAI, Inc.', 'A | B', '外博扣丁']);
  });

  it('keeps legacy one-column CSV import compatible and rejects unrecognized multi-column CSV', () => {
    const legacy = parseVoiceInputDictionaryImport('Claude Code\n"OpenAI, Inc."\n', 'legacy.csv');
    expect(legacy).toEqual({
      ok: true,
      format: 'csv',
      items: [
        { text: 'Claude Code', aliases: [] },
        { text: 'OpenAI, Inc.', aliases: [] },
      ],
      duplicateRowCount: 0,
      skippedTooLongCount: 0,
    });

    expect(parseVoiceInputDictionaryImport('Claude Code,Cloud Code', 'bad.csv')).toEqual({
      ok: false,
      reason: 'invalidFormat',
    });
    expect(parseVoiceInputDictionaryImport('{"notEntries":true}', 'bad.json')).toEqual({
      ok: false,
      reason: 'invalidFormat',
    });
  });
});
