import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { Session } from '@/lib/ccAgent.types';
import { emitPatch } from '@/lib/sessionsBus';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';

const log = createLogger('session-family');

/** 将一个分支任务提升为独立任务；本地与 device-link 都走现有窄元数据写链。 */
export function useDetachSessionFromFamily(session: Session): () => Promise<void> {
  const { t } = useTranslation();
  return useCallback(async () => {
    const parentSessionId = session.parentSessionId;
    if (!parentSessionId) return;
    if (isRemoteSessionWriteBlocked(session)) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }

    emitPatch(session.id, { parentSessionId: null });
    try {
      await sessionService.patchMeta(session.id, { parentSessionId: null });
    } catch (error) {
      log.warn('detach session family failed', error);
      emitPatch(session.id, { parentSessionId });
      toast.error(t('ccAgent.sidebar.sessionFamily.detachFailed'));
    }
  }, [session, t]);
}
