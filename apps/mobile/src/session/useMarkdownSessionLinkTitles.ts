import { useMemo } from 'react';
import { extractSessionLinkIds } from '@/session/sessionLinks';
import { useRemoteSessionTitles } from '@/session/remoteSessionStore';

/** Stable render context: only a referenced title changing invalidates spans. */
export function useMarkdownSessionLinkTitles(
  text: string,
): Record<string, string> | undefined {
  const idsJson = useMemo(() => JSON.stringify(extractSessionLinkIds(text)), [text]);
  const ids = useMemo(() => JSON.parse(idsJson) as string[], [idsJson]);
  return useRemoteSessionTitles(ids);
}
