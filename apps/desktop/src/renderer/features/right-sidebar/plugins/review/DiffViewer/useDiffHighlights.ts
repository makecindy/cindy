import { useEffect, useMemo, useState } from 'react';

import type { FileDiff } from '@/lib/gitReview.types';
import type { DiffRenderRow } from './diffRows';
import {
  collectHighlightLines,
  getCachedHighlight,
  highlightLine,
  languageFromPath,
  shouldSkipHighlightDiff,
} from './highlight';

interface HighlightState {
  signature: string;
  values: Map<string, string>;
}

const EMPTY_HIGHLIGHTS = new Map<string, string>();

export function useDiffHighlights(diff: FileDiff, rows: readonly DiffRenderRow[]): ReadonlyMap<string, string> {
  const language = useMemo(() => languageFromPath(diff.path), [diff.path]);
  const signature = useMemo(
    () => `${diff.id}:${language}:${hashRowsForHighlight(rows)}`,
    [diff.id, language, rows],
  );
  const [state, setState] = useState<HighlightState>({ signature: '', values: EMPTY_HIGHLIGHTS });
  // A remounted diff can already have cached tokens. Include them in its first
  // commit instead of publishing plain text and replacing it in a second AX update.
  const cachedHighlights = useMemo(() => {
    if (shouldSkipHighlightDiff(rows)) return EMPTY_HIGHLIGHTS;
    const values = new Map<string, string>();
    for (const line of collectHighlightLines(rows)) {
      const html = getCachedHighlight(language, line.content);
      if (html !== undefined) values.set(line.key, html);
    }
    return values;
  }, [language, rows]);

  useEffect(() => {
    if (typeof Worker === 'undefined' || shouldSkipHighlightDiff(rows)) return;

    const lines = collectHighlightLines(rows);
    if (lines.length === 0) return;
    if (cachedHighlights.size === lines.length) {
      // Keep this diff's tokens even if other files later evict the shared LRU.
      // Refreshing identical rows must not briefly publish plain text again.
      setState((current) => current.signature === signature ? current : { signature, values: cachedHighlights });
      return;
    }

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(lines.map(async (line) => {
        const html = await highlightLine(language, line.content);
        return html ? [line.key, html] as const : null;
      }));
      if (cancelled) return;
      const values = new Map<string, string>();
      for (const entry of entries) {
        if (entry) values.set(entry[0], entry[1]);
      }
      setState({ signature, values });
    })();

    return () => {
      cancelled = true;
    };
  }, [cachedHighlights, language, rows, signature]);

  return state.signature === signature ? state.values : cachedHighlights;
}

function hashRowsForHighlight(rows: readonly DiffRenderRow[]): string {
  let hash = 5381;
  const lines = collectHighlightLines(rows);
  for (const line of lines) {
    for (let i = 0; i < line.key.length; i += 1) {
      hash = ((hash << 5) + hash) ^ line.key.charCodeAt(i);
    }
    for (let i = 0; i < line.content.length; i += 1) {
      hash = ((hash << 5) + hash) ^ line.content.charCodeAt(i);
    }
  }
  return `${lines.length}:${hash >>> 0}`;
}
