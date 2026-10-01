import type { TFunction } from 'i18next';

import { TAB_LABEL_KEY, type SettingsTab, type VisibleSettingsTab } from '@/lib/tabLabels';

import type { SettingsSearchEntry, SettingsSearchModule, SettingsSearchContext } from './settingsSearchTypes';
export type { SettingsSearchEntry, SettingsSearchModule } from './settingsSearchTypes';

export interface SettingsSearchDocument {
  entry: SettingsSearchEntry;
  title: string;
  section: string;
  category: string;
  searchText: string;
}

/** Sidecar declarations are discovered even when the owning page has never mounted. */
const modules = import.meta.glob<SettingsSearchModule>('./**/*.settings-search.ts', { eager: true, import: 'default' });
export const SETTINGS_SEARCH_MODULES = Object.values(modules).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_MODULES.flatMap((module) => module.entries);

export function normalizeSettingsSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function buildSettingsSearchDocuments(
  t: TFunction,
  visibleTabIds: readonly VisibleSettingsTab[],
  context?: SettingsSearchContext,
): SettingsSearchDocument[] {
  const visible = new Set(visibleTabIds);
  return SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => visible.has(entry.tab) && (!entry.isVisible || (context !== undefined && entry.isVisible(context))),
  ).map((entry) => {
    const text = (key: string, english = false) => {
      const value: unknown = t(key, { ...(english ? { lng: 'en' } : {}), defaultValue: '' });
      return typeof value === 'string' && value !== key ? value.replace(/{{[^}]+}}/g, '') : '';
    };
    const title = text(entry.titleKey);
    const section = text(entry.sectionKey);
    const category = text(TAB_LABEL_KEY[entry.tab]);
    const english = [
      text(entry.titleKey, true),
      text(entry.sectionKey, true),
      text(TAB_LABEL_KEY[entry.tab], true),
    ];
    const searchText = normalizeSettingsSearchText(
      [title, section, category, ...english, ...(entry.keywordKeys ?? []).flatMap((key) => [text(key), text(key, true)]), ...(entry.descriptionKey ? [text(entry.descriptionKey), text(entry.descriptionKey, true)] : []), ...(entry.aliases ?? [])].join(' '),
    );
    return { entry, title, section, category, searchText };
  });
}

export function searchSettings(
  documents: readonly SettingsSearchDocument[],
  query: string,
): SettingsSearchDocument[] {
  const normalizedQuery = normalizeSettingsSearchText(query);
  if (!normalizedQuery) return [];

  return documents
    .map((document, index) => {
      const title = normalizeSettingsSearchText(document.title);
      const section = normalizeSettingsSearchText(document.section);
      const category = normalizeSettingsSearchText(document.category);
      if (
        !document.searchText.includes(normalizedQuery) &&
        !normalizedQuery.split(' ').every((token) => document.searchText.includes(token))
      ) {
        return null;
      }
      let score = 100;
      if (title === normalizedQuery) score += 1000;
      else if (title.startsWith(normalizedQuery)) score += 700;
      else if (title.includes(normalizedQuery)) score += 500;
      if (section.includes(normalizedQuery)) score += 300;
      if (category.includes(normalizedQuery)) score += 100;
      return { document, score, index };
    })
    .filter((match): match is { document: SettingsSearchDocument; score: number; index: number } => match !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((match) => match.document);
}

/** Coverage guard: every declaration must be complete and have a unique id. */
export function validateSettingsSearchCatalog(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (ids.has(entry.id)) errors.push('duplicate id: ' + entry.id);
    ids.add(entry.id);
    if (!entry.tab || !entry.targetId || !entry.titleKey || !entry.sectionKey) {
      errors.push('incomplete entry: ' + entry.id);
    }
  }
  return errors;
}

/** Accept existing short deep links, catalog ids, and concrete target ids. */
export function resolveSettingsSearchEntry(
  tab: SettingsTab,
  section: string | null,
): SettingsSearchEntry | null {
  if (!section) return null;
  const normalized = normalizeSettingsSearchText(section);
  return SETTINGS_SEARCH_ENTRIES.find(
    (entry) =>
      entry.tab === tab &&
      [entry.id, entry.id.split('.').at(-1) ?? '', entry.targetId, ...(entry.aliases ?? [])].some(
        (alias) => normalizeSettingsSearchText(alias) === normalized,
      ),
  ) ?? null;
}


export function resolveSettingsSearchTarget(tab: SettingsTab, section: string | null): string | null {
  return resolveSettingsSearchEntry(tab, section)?.targetId ?? null;
}
