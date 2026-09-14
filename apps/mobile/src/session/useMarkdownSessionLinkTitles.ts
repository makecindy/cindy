import { useMemo } from 'react';
import { extractSessionLinkIds } from '@/session/sessionLinks';

/** Stable render context: only a referenced title changing invalidates spans. */
export function useMarkdownSessionLinkTitles(
  text: string,
  sessions: readonly { id: string; title?: string | null }[],
): Record<string, string> | undefined {
  const idsJson = useMemo(() => JSON.stringify(extractSessionLinkIds(text)), [text]);
  const titlesJson = useMemo(() => {
    const ids = JSON.parse(idsJson) as string[];
    if (ids.length === 0) return undefined;
    const titles: Record<string, string> = {};
    for (const id of ids) {
      const title = sessions.find((session) => session.id === id)?.title?.trim();
      if (title) titles[id] = title;
    }
    return Object.keys(titles).length > 0 ? JSON.stringify(titles) : undefined;
  }, [idsJson, sessions]);
  return useMemo(() => titlesJson === undefined
    ? undefined
    : JSON.parse(titlesJson) as Record<string, string>, [titlesJson]);
}
