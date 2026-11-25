import { useCallback, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/ccAgent.types';
import { getDraftPresence, subscribeDraftPresence } from '@/lib/composerDraftStore';
import type { QueuedMessage } from '@/lib/makerChatStore';
import { toast } from '@/lib/toast';
import { dagRecallRecoveryKey, recallDagQueuedQuestion, takeDagRecalledDraft } from './DagRecallDraft';

export function DagPendingRecall({ session, entry, writable }: { session: Session; entry: QueuedMessage; writable: () => boolean }) {
  return <Button type="button" size="sm" variant="secondary" onClick={async () => {
    const result = await recallDagQueuedQuestion(session, entry, writable);
    if (!result.ok) toast.warning(result.reason);
  }}>撤回到输入框</Button>;
}
export function DagPendingRecallRecovery({ id }: { id: string }) {
  const key = dagRecallRecoveryKey(id);
  const present = useSyncExternalStore(useCallback(notify => subscribeDraftPresence(key, notify), [key]), () => getDraftPresence(key));
  return present ? <Button type="button" size="sm" variant="secondary" onClick={() => {
    const result = takeDagRecalledDraft(id);
    if (!result.ok) toast.warning(result.reason);
  }}>取回已撤回的问题</Button> : null;
}
