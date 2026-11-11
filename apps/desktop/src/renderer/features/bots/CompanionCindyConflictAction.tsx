import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast, type ToastAction } from '@/lib/toast';
import type { CompanionCloudActionResult } from '../../../shared/companionCloud';
import { ensureBotProfilesLoaded } from './botStore';
import { getCompanionCloudSnapshot } from './companionCloudStore';

/** Locate even a hidden, unregistered local copy through its existing settings. No data is changed. */
export function useCompanionCindyConflictAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [action, setAction] = useState<ToastAction | undefined>();
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; };
  }, []);
  const clear = () => { revision.current++; setAction(undefined); };
  const report = (result: CompanionCloudActionResult): ToastAction | undefined => {
    const cloud = getCompanionCloudSnapshot();
    const owner = getDataOwnerGeneration();
    // A conflict reported by another computer must never open or clean up a local same-ID copy.
    if (result.ok || result.code !== 'LOCAL_CINDY_CONFLICT' || !result.conflictingBotId
      || !cloud.selfDeviceId || result.conflictingDeviceId !== cloud.selfDeviceId
      || cloud.demotedBotIds.includes(result.conflictingBotId)) {
      clear();
      return undefined;
    }
    const botId = result.conflictingBotId;
    const epoch = ++revision.current;
    const current = () => alive.current && revision.current === epoch && isDataOwnerGenerationCurrent(owner);
    const next: ToastAction = {
      label: t('bots.cloud.localCindyConflictAction'),
      onClick: () => {
        if (!current()) return;
        void ensureBotProfilesLoaded(true).then(profiles => {
          if (!current()) return;
          if (!profiles.some(profile => profile.id === botId)) throw new Error('NOT_FOUND');
          // Match BotSettingsDrawer's read-only boundary, including a demotion while loading.
          if (getCompanionCloudSnapshot().demotedBotIds.includes(botId)) throw new Error('NOT_EDITABLE');
          navigate(`/bots/${encodeURIComponent(botId)}?settings=1`);
        }).catch(() => {
          if (current()) toast.error(t('bots.lifecycle.actionFailed'));
        });
      },
    };
    setAction(next);
    return next;
  };
  return { action, report, clear };
}

export function CompanionCindyConflictAction({ action }: { action?: ToastAction }) {
  return action ? <Button type="button" variant="secondary" size="md" onClick={() => action.onClick()}>
    {action.label}
  </Button> : null;
}
