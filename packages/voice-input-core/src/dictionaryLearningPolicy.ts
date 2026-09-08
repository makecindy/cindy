import type { DictationDictionaryLearningAction } from './DictationDictionaryAdvisor';
import { dictionaryTermKey, normalizeDictionaryTermText } from './dictionary-sync/text';

export const DICTIONARY_CANDIDATE_PROMOTION_COUNT = 3;

/** One advisor result contributes at most one observation per word and alias. */
export function coalesceDictionaryLearningActions(
  actions: ReadonlyArray<DictationDictionaryLearningAction>,
): DictationDictionaryLearningAction[] {
  const words = new Map<string, DictationDictionaryLearningAction>();
  const rank = { add_candidate: 0, add_entry: 1, update_entry: 2 };
  for (const action of actions) {
    if (action.confidence === 'low') continue;
    const term = normalizeDictionaryTermText(action.term);
    const key = dictionaryTermKey(term);
    if (!key) continue;
    const previous = words.get(key);
    const aliases = new Map<string, string>();
    for (const raw of [...(previous?.aliases ?? []), ...(action.aliases ?? [])]) {
      const alias = normalizeDictionaryTermText(raw);
      const aliasKey = dictionaryTermKey(alias);
      if (aliasKey && aliasKey !== key && !aliases.has(aliasKey)) aliases.set(aliasKey, alias);
    }
    const preferred = previous && rank[previous.action] >= rank[action.action] ? previous : action;
    words.set(key, { ...preferred, term: previous?.term ?? term, aliases: [...aliases.values()] });
  }
  return [...words.values()];
}
