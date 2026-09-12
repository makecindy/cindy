import {
  QUICK_SWITCHER_PAGE_SIZE,
  type QuickSwitcherCatalogPage,
  type QuickSwitcherSession,
} from '../../shared/quickSwitcher';

/** Complete, cancelable directory read. Unknown/legacy payloads never count as complete. */
export async function readQuickSwitcherCatalog(
  fetchPage: (cursor: string | null) => Promise<QuickSwitcherCatalogPage>,
  isCurrent: () => boolean,
): Promise<QuickSwitcherSession[] | null> {
  let cursor: string | null = null;
  const rows = new Map<string, QuickSwitcherSession>();
  do {
    if (!isCurrent()) return null;
    const page = await fetchPage(cursor);
    if (!isCurrent()) return null;
    if (
      page?.version !== 1 ||
      !Array.isArray(page.sessions) ||
      page.sessions.length > QUICK_SWITCHER_PAGE_SIZE ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' || page.nextCursor <= (cursor ?? '')))
    ) {
      throw new Error('Unsupported or incomplete title catalogue');
    }
    let previousId = cursor ?? '';
    if (page.nextCursor !== null && page.sessions.at(-1)?.id !== page.nextCursor)
      throw new Error('Unsupported or incomplete title catalogue');
    for (const row of page.sessions) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        row.id <= previousId ||
        typeof row.title !== 'string' ||
        !['active', 'archived'].includes(row.status) ||
        !Number.isFinite(Date.parse(row.updatedAt))
      )
        throw new Error('Invalid title catalogue');
      rows.set(row.id, row);
      previousId = row.id;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return [...rows.values()];
}
