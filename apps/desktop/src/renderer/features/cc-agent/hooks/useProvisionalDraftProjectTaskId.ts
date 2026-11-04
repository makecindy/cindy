import { useSyncExternalStore } from 'react';
import {
  getProvisionalDraftProjectTaskId,
  subscribeProvisionalDraftTaskId,
} from '../lib/provisionalDraftTaskId';

/** Keep all project catalogues aligned with the sidebar during draft handoff. */
export function useProvisionalDraftProjectTaskId(): string | null {
  return useSyncExternalStore(subscribeProvisionalDraftTaskId, getProvisionalDraftProjectTaskId);
}
