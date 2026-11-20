import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { findLinkedSideChatTab, reopenLinkedSideChat } from '@/features/right-sidebar/lib/openSideChatTab';
import { ensureHydrated, getBucket, subscribe } from '@/features/right-sidebar/store';
import type { Session } from '@/lib/ccAgent.types';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useRightSidebarWindowState } from '@/lib/rightSidebarWindowState';
import { readSessionBatch } from '@/lib/sessionBatchRead';
import { toast } from '@/lib/toast';
import { getSessionDisplayTitle } from './lib/sessionDisplayTitle';

interface LinkedSideChatOriginProps {
  childId: string;
  parentId: string | null;
  deviceId: string | null;
  parentAccessAvailable: boolean;
  archived?: boolean;
}

export function LinkedSideChatOrigin({ childId, parentId, deviceId, parentAccessAvailable, archived = false }: LinkedSideChatOriginProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [parent, setParent] = useState<Session | null>();
  const [opening, setOpening] = useState(false);
  const sidebarWindow = useRightSidebarWindowState();
  const parentUnavailable = !parentId || !parentAccessAvailable || parent === null
    || parent?.status === 'deleted' || Boolean(parent?.hiddenAt);
  const accessibleParent = parentUnavailable ? null : parent;
  const subscribeParentTabs = useCallback((change: () => void) => subscribe(id => {
    if (id === parentId) change();
  }), [parentId]);
  const readParentTabState = useCallback(() => {
    if (!parentId || !getBucket(parentId).hydrated) return null;
    if (findLinkedSideChatTab(parentId, childId, deviceId)) return true;
    // A legacy detached window can still own the remote in-memory tab bucket.
    return deviceId && (!sidebarWindow.loaded || sidebarWindow.detached) ? null : false;
  }, [childId, deviceId, parentId, sidebarWindow.loaded, sidebarWindow.detached]);
  const tabOpen = useSyncExternalStore(subscribeParentTabs, readParentTabState);

  useEffect(() => {
    if (!parentId || !parentAccessAvailable) return;
    const owner = getDataOwnerGeneration();
    let disposed = false;
    let bufferedPatch: Partial<Session> = {};
    const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const applyPatch = (payload: { sessionId?: string; patch?: Partial<Session> } | null) => {
      const patch = payload?.patch;
      if (!current() || payload?.sessionId !== parentId || !patch) return;
      const { title, status, hiddenAt } = patch;
      if (title === undefined && status === undefined && hiddenAt === undefined) return;
      const update = {
        ...(title !== undefined && { title }),
        ...(status !== undefined && { status }),
        ...(hiddenAt !== undefined && { hiddenAt }),
      };
      bufferedPatch = { ...bufferedPatch, ...update };
      setParent(previous => previous ? { ...previous, ...update } : previous);
    };
    const off = deviceId ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (push.deviceId === deviceId && push.channel === 'local-db:sessions:patched' && isDeviceLinkRemotePushCurrent(push, stamp)) {
        applyPatch(push.payload as Parameters<typeof applyPatch>[0]);
      }
    }) : window.electronAPI.localDb.sessionsPush.onPatched((payload, stamp) => {
      if (isDataOwnerPushCurrent(stamp)) applyPatch(payload);
    });
    void readSessionBatch([parentId], deviceId ?? undefined).then(([result]) => {
      if (!current()) return;
      setParent(result?.value?.id === parentId ? { ...result.value, ...bufferedPatch } : null);
    }).catch(() => { if (current()) setParent(null); });
    return () => { disposed = true; off(); };
  }, [deviceId, parentAccessAvailable, parentId]);

  const canReadTab = Boolean(accessibleParent) && (!deviceId || (sidebarWindow.loaded && !sidebarWindow.detached));
  useEffect(() => {
    if (!canReadTab || !parentId) return;
    if (deviceId) remoteProjectsStore.pinSessionOrigin(deviceId, parentId);
    void ensureHydrated(parentId).catch(() => undefined);
  }, [canReadTab, deviceId, parentId]);

  const displayTitle = accessibleParent && getSessionDisplayTitle(accessibleParent, t('ccAgent.common.unnamedSession'), t);
  const description = displayTitle
    ? t('chat.sideChat.originNamed', { title: displayTitle })
    : t(parentUnavailable ? 'chat.sideChat.originUnavailable' : 'chat.sideChat.origin');
  return (
    <div className="mx-4 flex min-w-0 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-default)] py-2" data-testid="linked-side-chat-origin">
      <p className="min-w-0 truncate text-13 leading-5 text-[var(--text-primary)]" title={description}>{description}</p>
      {!archived && parentId && accessibleParent && tabOpen !== null && (
        <Button variant="secondary" tone="quiet" size="sm" className="shrink-0" disabled={opening} onClick={() => {
          setOpening(true);
          void reopenLinkedSideChat(parentId, childId, deviceId, navigate)
            .catch(() => toast.error(t('chat.sideChat.failed')))
            .finally(() => setOpening(false));
        }}>
          <ArrowLeft aria-hidden="true" size={14} />
          {t(tabOpen ? 'chat.sideChat.returnToSideChat' : 'chat.sideChat.reopenSideChat')}
        </Button>
      )}
    </div>
  );
}
