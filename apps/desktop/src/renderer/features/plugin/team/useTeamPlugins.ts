/**
 * Organization plugins the member creates or maintains. Read on page visit, owner change, explicit
 * refresh and when the review-change signal moves; never polled as a whole list.
 * Long lists are read in bounded batches; `nextCursor` lets the page continue instead of
 * silently truncating.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PersonalPluginSummary } from '../../../../shared/pluginAuthor';
import { extractIpcError } from '@/utils/ipcError';
import { contributionErrorKey } from '../lib/useContributionPreview';

export type TeamPluginsState =
  | { status: 'loading'; plugins: PersonalPluginSummary[] | null; nextCursor: string | null }
  | { status: 'ready'; plugins: PersonalPluginSummary[]; nextCursor: string | null }
  /** Server predates author APIs: the team group is hidden. */
  | { status: 'unsupported' }
  | { status: 'failed'; plugins: PersonalPluginSummary[] | null; nextCursor: string | null; errorKey: string };

export function useTeamPlugins(
  enabled: boolean,
  ownerKey: string,
  /** Changes on explicit refresh and when organization review results change. */
  refreshKey: string | number,
): TeamPluginsState & { loadMore: () => void } {
  const [state, setState] = useState<{ owner: string; value: TeamPluginsState } | null>(null);
  const request = useRef(0);
  const current = state?.owner === ownerKey ? state.value : null;
  const previous = current && 'plugins' in current ? current : null;

  const read = useCallback((cursor: string | null, keep: PersonalPluginSummary[]) => {
    const id = ++request.current;
    setState({ owner: ownerKey, value: { status: 'loading', plugins: keep.length || cursor ? keep : null, nextCursor: cursor } });
    window.electronAPI.pluginAuthor.listPlugins(cursor ?? undefined).then(
      (page) => {
        if (request.current !== id) return;
        setState({ owner: ownerKey, value: { status: 'ready', plugins: [...keep, ...page.plugins], nextCursor: page.nextCursor } });
      },
      (error: unknown) => {
        if (request.current !== id) return;
        if (extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY') {
          setState({ owner: ownerKey, value: { status: 'unsupported' } });
          return;
        }
        setState({
          owner: ownerKey,
          value: { status: 'failed', plugins: keep.length ? keep : null, nextCursor: cursor, errorKey: contributionErrorKey(error) },
        });
      },
    );
  }, [ownerKey]);

  useEffect(() => {
    if (!enabled) return;
    read(null, []);
    return () => {
      request.current += 1;
    };
  }, [enabled, read, refreshKey]);

  // After a failed page the same cursor is kept, so "load more" retries exactly that page.
  const loadMore = useCallback(() => {
    if ((previous?.status === 'ready' || previous?.status === 'failed') && previous.nextCursor) {
      read(previous.nextCursor, previous.plugins ?? []);
    }
  }, [previous, read]);

  if (!enabled) return { status: 'unsupported', loadMore };
  return { ...(current ?? { status: 'loading', plugins: null, nextCursor: null }), loadMore };
}
