/**
 * useSubagentRunStatusIndex — the host's durable `subagent_runs` status for one
 * task, indexed by every id a spawning tool call can be matched by.
 *
 * `subagent_runs` is written from structured lifecycle events (Claude
 * `async_launched` / `task_notification`, Codex and PI observations), so it does
 * not depend on the wording of a launch receipt. Chat cards and the background
 * task panel read it through {@link deriveAgentTaskStatus}'s `durableStatus`.
 *
 * Local tasks only: the device-link list is deliberately narrowed to PI runs on
 * the data-owning device, so a remote task gets an empty index and keeps the
 * existing live-update + receipt-text derivation.
 */

import { useEffect, useState } from 'react';
import {
  buildSubagentRunStatusIndex,
  type SubagentRunStatusIndex,
} from '@cindy/maker-shared/agent-task';
import type { SubagentRun, SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isCurrentSubagentRunsChange } from '@/features/right-sidebar/plugins/subagents/subagentChangeFence';

const EMPTY_INDEX: SubagentRunStatusIndex = new Map();
/** The host clamps list pages to 100; a task with more runs keeps its newest 1000. */
const LIST_PAGE_LIMIT = 100;
const MAX_LIST_PAGES = 10;
const CHANGE_DEBOUNCE_MS = 50;

function sameStatusIndex(a: SubagentRunStatusIndex, b: SubagentRunStatusIndex): boolean {
  if (a.size !== b.size) return false;
  for (const [key, status] of a) {
    if (b.get(key) !== status) return false;
  }
  return true;
}

export function useSubagentRunStatusIndex(input: {
  sessionId: string | null | undefined;
  /** Data-owning device of a device-link task; null/undefined = this machine. */
  deviceId?: string | null;
  enabled?: boolean;
}): SubagentRunStatusIndex {
  const { sessionId, deviceId, enabled = true } = input;
  const local = !(typeof deviceId === 'string' && deviceId.length > 0);
  const [state, setState] = useState<{ sessionId: string; index: SubagentRunStatusIndex } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || !local || !sessionId) return;
    const api = window.electronAPI?.localDb?.subagentRuns;
    if (!api) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Each read supersedes the previous one; only the newest may publish.
    let readSeq = 0;

    const read = async (): Promise<void> => {
      const seq = ++readSeq;
      const owner = getDataOwnerGeneration();
      const runs: SubagentRun[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const request = { sessionId, limit: LIST_PAGE_LIMIT, ...(cursor ? { cursor } : {}) };
        const response = (await api.list(request)) as SubagentRunsListResponse;
        if (disposed || seq !== readSeq || !isDataOwnerGenerationCurrent(owner)) return;
        if (!response.supported) break;
        runs.push(...response.runs);
        cursor = response.nextCursor;
        if (!cursor) break;
      }
      const index = runs.length > 0 ? buildSubagentRunStatusIndex(runs) : EMPTY_INDEX;
      // Progress pushes usually leave every status unchanged; keep the old Map
      // so the chat's render projection cache is not invalidated for nothing.
      setState((previous) =>
        previous?.sessionId === sessionId && sameStatusIndex(previous.index, index)
          ? previous
          : { sessionId, index },
      );
    };
    const refresh = (): void => {
      const seq = readSeq + 1;
      const owner = getDataOwnerGeneration();
      void read().catch(() => {
        // A failed re-read must not leave an older index in force: its terminal
        // statuses would outrank a resumed run's live `running` update. Drop to
        // the empty index so rendering falls back to the live derivation.
        if (disposed || seq !== readSeq || !isDataOwnerGenerationCurrent(owner)) return;
        setState({ sessionId, index: EMPTY_INDEX });
      });
    };

    refresh();
    const unsubscribe = api.onChanged((payload, ownerStamp) => {
      if (!isCurrentSubagentRunsChange(payload, ownerStamp, sessionId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, CHANGE_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, local, sessionId]);

  // Keyed by the task it was read for, so switching tasks never shows the
  // previous task's statuses while the new read is in flight.
  if (!enabled || !local || !sessionId || state?.sessionId !== sessionId) return EMPTY_INDEX;
  return state.index;
}
