export const HOME_SUGGESTION_BATCH_SIZE = 4;
export const HOME_SUGGESTIONS_HIDDEN_KEY = 'cindy.homeSuggestions.hidden';

export const HOME_SUGGESTION_IDS = [
  'downloadsDesktop',
  'whatCindyCanDo',
  'recentDocs',
  'listCodeProjects',
  'storageUsage',
  'unusedApps',
  'uncommittedChanges',
  'devEnvironment',
  'whySlow',
  'diagnoseNetwork',
  'subscriptionSpend',
  'expenseTracker',
] as const;

export type HomeSuggestionId = (typeof HOME_SUGGESTION_IDS)[number];

export const HOME_SUGGESTION_BATCH_COUNT = HOME_SUGGESTION_IDS.length / HOME_SUGGESTION_BATCH_SIZE;

export function homeSuggestionLabelKey(
  id: HomeSuggestionId,
): `newChat.homeSuggestions.${HomeSuggestionId}.label` {
  return `newChat.homeSuggestions.${id}.label`;
}

export function homeSuggestionPromptKey(
  id: HomeSuggestionId,
): `newChat.homeSuggestions.${HomeSuggestionId}.prompt` {
  return `newChat.homeSuggestions.${id}.prompt`;
}

export function homeSuggestionBatch(index: number): HomeSuggestionId[] {
  const batchCount = HOME_SUGGESTION_BATCH_COUNT;
  const normalized = ((index % batchCount) + batchCount) % batchCount;
  const start = normalized * HOME_SUGGESTION_BATCH_SIZE;
  return HOME_SUGGESTION_IDS.slice(start, start + HOME_SUGGESTION_BATCH_SIZE);
}

export function nextHomeSuggestionBatch(index: number): number {
  return (index + 1) % HOME_SUGGESTION_BATCH_COUNT;
}

export function isHomeSuggestionsHidden(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(HOME_SUGGESTIONS_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHomeSuggestionsHidden(hidden: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (hidden) localStorage.setItem(HOME_SUGGESTIONS_HIDDEN_KEY, '1');
    else localStorage.removeItem(HOME_SUGGESTIONS_HIDDEN_KEY);
  } catch {
    // quota / private mode: keep the in-memory hide from the caller
  }
}
