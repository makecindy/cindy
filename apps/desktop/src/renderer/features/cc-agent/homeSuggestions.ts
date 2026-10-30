export const HOME_SUGGESTION_BATCH_SIZE = 4;
export const HOME_SUGGESTIONS_HIDDEN_KEY = 'cindy.homeSuggestions.hidden';

// Broad user scenarios, not individual actions such as cleanup/diagnose/organize.
export const HOME_SUGGESTION_CATALOG = [
  { id: 'storageUsage', category: 'computer' },
  { id: 'whySlow', category: 'computer' },
  { id: 'downloadsDesktop', category: 'computer' },
  { id: 'diagnoseNetwork', category: 'computer' },
  { id: 'unusedApps', category: 'computer' },
  { id: 'stockDigest', category: 'automation' },
  { id: 'morningBrief', category: 'automation' },
  { id: 'watchWebpage', category: 'automation' },
  { id: 'expenseTracker', category: 'create' },
  { id: 'kidsGame', category: 'create' },
  { id: 'habitTracker', category: 'create' },
  { id: 'recentDocs', category: 'documents' },
  { id: 'subscriptionSpend', category: 'documents' },
  { id: 'organizeFolder', category: 'documents' },
  { id: 'photoTimeline', category: 'photos' },
  { id: 'photoAlbumPage', category: 'photos' },
  { id: 'uncommittedChanges', category: 'development' },
  { id: 'exploreRepo', category: 'development' },
  { id: 'initAgentDoc', category: 'development' },
  { id: 'listCodeProjects', category: 'development' },
  { id: 'devEnvironment', category: 'development' },
  { id: 'makePlugin', category: 'cindy' },
  { id: 'sendFeedback', category: 'cindy' },
  { id: 'readOwnSource', category: 'cindy' },
  { id: 'whatCindyCanDo', category: 'discovery' },
] as const;

export type HomeSuggestionId = (typeof HOME_SUGGESTION_CATALOG)[number]['id'];
export const HOME_SUGGESTION_IDS = HOME_SUGGESTION_CATALOG.map(({ id }) => id);

export interface HomeSuggestionCandidate {
  /** Globally unique identity and broad category assigned by the host. */
  id: string;
  category: string;
  pluginId?: string;
  needsInstall?: boolean;
}

/** Candidates arrive in host priority order; every position shares the same quotas. */
export function selectHomeSuggestionBatch<T extends HomeSuggestionCandidate>(
  candidates: readonly T[],
  {
    size = HOME_SUGGESTION_BATCH_SIZE,
    pinnedId,
    fallback = [],
  }: { size?: 2 | 4; pinnedId?: string; fallback?: readonly T[] } = {},
): T[] {
  const selected: T[] = [];
  const ids = new Set<string>();
  const categories = new Set<string>();
  const plugins = new Set<string>();
  let installGuideSelected = false;
  // A withdrawn candidate cannot be revived just because its old ID was pinned.
  const pinned = candidates.find(({ id }) => id === pinnedId);
  for (const candidate of [...(pinned ? [pinned] : []), ...candidates, ...fallback]) {
    if (
      ids.has(candidate.id) ||
      categories.has(candidate.category) ||
      (candidate.pluginId !== undefined && plugins.has(candidate.pluginId)) ||
      (candidate.needsInstall === true && installGuideSelected)
    ) {
      continue;
    }
    selected.push(candidate);
    ids.add(candidate.id);
    categories.add(candidate.category);
    if (candidate.pluginId !== undefined) plugins.add(candidate.pluginId);
    if (candidate.needsInstall) installGuideSelected = true;
    if (selected.length === size) break;
  }
  return selected;
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Give each category an equal draw, regardless of how many topics it contains. */
export function randomCategoryOrder<T extends HomeSuggestionCandidate>(
  candidates: readonly T[],
  random: () => number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.category) ?? [];
    group.push(candidate);
    groups.set(candidate.category, group);
  }
  return shuffled([...groups.values()], random).flatMap((group) => shuffled(group, random));
}

export interface HomeSuggestionBatchState {
  ids: HomeSuggestionId[];
  seenIds: HomeSuggestionId[];
  /** Largest number of rows displayed in this batch, even after shrinking the window. */
  displayedCount: 2 | 4;
}

/** Random draws, with unseen topics first and the current visible topics last. */
export function nextHomeSuggestionBatch(
  previous: HomeSuggestionBatchState | null = null,
  visibleCount: 2 | 4 = HOME_SUGGESTION_BATCH_SIZE,
  random: () => number = Math.random,
): HomeSuggestionBatchState {
  const previousIds = new Set(previous?.ids.slice(0, previous.displayedCount));
  const seen = new Set([...(previous?.seenIds ?? []), ...previousIds]);
  if (seen.size === HOME_SUGGESTION_CATALOG.length) seen.clear();

  const available = HOME_SUGGESTION_CATALOG.filter(({ id }) => !previousIds.has(id));
  const unseen = available.filter(({ id }) => !seen.has(id));
  const seenBefore = available.filter(({ id }) => seen.has(id));
  const candidates = [
    ...randomCategoryOrder(unseen, random),
    ...randomCategoryOrder(seenBefore, random),
  ];
  const selected = selectHomeSuggestionBatch(candidates, {
    fallback: randomCategoryOrder(
      HOME_SUGGESTION_CATALOG.filter(({ id }) => previousIds.has(id)),
      random,
    ),
  });
  // Prepare four rows so resizing preserves the batch. Only visible rows enter history
  // on the next shuffle; the two hidden rows on narrow screens remain eligible.
  return { ids: selected.map(({ id }) => id), seenIds: [...seen], displayedCount: visibleCount };
}

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
