import { dictionaryTermKey } from '@cindy/voice-input-core';

import {
  MAX_VOICE_INPUT_DICTIONARY_ALIASES,
  normalizeVoiceInputDictionaryEntryText,
  type VoiceInputDictionaryEntry,
  type VoiceInputDictionaryEntrySource,
} from '../../shared/voiceInputData';

export type VoiceInputDictionaryFilter = 'all' | VoiceInputDictionaryEntrySource;

/** 编辑框一行一个误识别写法，便于直接增删和调整。 */
export function formatVoiceInputDictionaryAliasDraft(
  aliases: VoiceInputDictionaryEntry['aliases'],
): string {
  return aliases.map((alias) => alias.text).join('\n');
}

/** 按行读取，归一化、去重并排除与主词条相同的写法。逗号和分号可以是别名正文。 */
export function parseVoiceInputDictionaryAliasDraft(draft: string, termText: string): string[] {
  const termKey = dictionaryTermKey(termText);
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const part of draft.replace(/\r\n?/g, '\n').split(/\n+/)) {
    const text = normalizeVoiceInputDictionaryEntryText(part);
    const key = dictionaryTermKey(text);
    if (!key || key === termKey || seen.has(key)) continue;
    seen.add(key);
    aliases.push(text);
    if (aliases.length >= MAX_VOICE_INPUT_DICTIONARY_ALIASES) break;
  }
  return aliases;
}

export function voiceInputDictionaryEntryMatches(
  entry: VoiceInputDictionaryEntry,
  filter: VoiceInputDictionaryFilter,
  query: string,
): boolean {
  if (filter !== 'all' && entry.source !== filter) return false;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [entry.text, ...entry.aliases.map((alias) => alias.text)].some((text) =>
    text.toLocaleLowerCase().includes(normalizedQuery),
  );
}
