import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { isSelectableVendor } from '@/lib/agentVendors';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';

function ResolveMergeButton({ state }: { state: CindyMakeMergeState }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const resolve = async () => {
    if (submitting.current) return;
    const owner = getDataOwnerGeneration();
    submitting.current = true;
    setBusy(true);
    try {
      const draftState = await import('@/state/newMakerDraft');
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const draft = draftState.getDraft();
      const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
      const prefs = draft.lastByVendor[vendor];
      const result = await window.electronAPI.cindyMakeMerge({
        action: 'resolve',
        createOptions: {
          agentKind: vendor,
          model: prefs.model,
          effort: prefs.effort,
          providerId: prefs.providerId,
          permissionMode: prefs.permissionMode,
          fastMode: draftState.getFastModeForModel(prefs.model),
          planModeEnabled: false,
        },
      });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (result?.sessionId) navigate(`/cc-agent/${result.sessionId}`);
      else toast.error(t('cindyMake.merge.errors.startFailed'));
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMake.merge.errors.startFailed'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Tip text={t('cindyMake.merge.resolveHint')}>
      <Button variant="secondary" disabled={busy} onClick={() => void resolve()}>
        {busy && <Spinner size={14} />}
        {t(state.sessionId ? 'cindyMake.merge.openTask' : 'cindyMake.merge.resolve')}
      </Button>
    </Tip>
  );
}

export function CindyMakeMergeNotice({ state }: { state: CindyMakeMergeState }) {
  const { t } = useTranslation();
  const active = ['fetching', 'merging', 'checking'].includes(state.status);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3 text-12">
      <div className="min-w-0 flex-1 space-y-1 text-[var(--text-secondary)]" role="status">
        <p className="flex items-center gap-2">
          {active && <Spinner size={14} />}
          {t(`cindyMake.merge.status.${state.status}`)}
        </p>
        {state.error && (
          <p className="text-[var(--status-danger)]">
            {t(`cindyMake.merge.errors.${state.error}`)}
          </p>
        )}
        {state.ownedByAnotherAccount && <p>{t('cindyMake.merge.otherAccount')}</p>}
      </div>
      {!active &&
        state.hasWorkspace &&
        state.status !== 'merged' &&
        !state.ownedByAnotherAccount && <ResolveMergeButton state={state} />}
    </div>
  );
}
