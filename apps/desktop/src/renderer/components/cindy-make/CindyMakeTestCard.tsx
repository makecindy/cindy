import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { makerChatStore } from '@/lib/makerChatStore';
import { useCindyVersions } from '@/lib/useCindyVersions';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { extractIpcError } from '@/utils/ipcError';
import type {
  CindyMakeCompletionMeta,
  CindyMakeTestAction,
  CindyMakeTestState,
} from '../../../shared/cindyMakeSession';
import { CindyMakeCompleteCard } from './CindyMakeCompleteCard';

export function CindyMakeTestCard({
  sessionId,
  completionId,
  meta,
}: {
  sessionId: string;
  completionId: string;
  meta: CindyMakeCompletionMeta;
}) {
  const { t } = useTranslation();
  const versions = useCindyVersions(!!meta.personal?.versionId, meta.personal?.versionId);
  const [pending, setPending] = useState<Exclude<CindyMakeTestAction, 'status'>>();
  const [error, setError] = useState<{
    mode: 'test' | 'build';
    code: CindyMakeTestState['error'];
  }>();
  const busy = useRef(false);
  const active = useRef(true);
  const version = useRef(0);
  const latest = useRef(meta);
  latest.current = meta;
  const owner = getDataOwnerGeneration();
  const current = () =>
    active.current && isDataOwnerGenerationCurrent(owner) && !getStickySessionDeviceId(sessionId);
  useEffect(() => {
    active.current = true;
    const initial = latest.current;
    const requestVersion = ++version.current;
    void window.electronAPI
      .cindyMakeTest(sessionId, completionId, 'status')
      .then((next) => {
        if (current() && latest.current === initial && version.current === requestVersion)
          makerChatStore.updateSystemCardData(sessionId, completionId, { ...next });
      })
      .catch(() => {});
    return () => {
      active.current = false;
    };
  }, [sessionId, completionId, owner.dataOwnerId, owner.generation]);
  const act = async (action: Exclude<CindyMakeTestAction, 'status'>) => {
    if (busy.current || !current()) return;
    busy.current = true;
    version.current += 1;
    setPending(action);
    setError(undefined);
    const initial = latest.current;
    try {
      const next = await window.electronAPI.cindyMakeTest(sessionId, completionId, action);
      if (current() && (action === 'continue' || latest.current === initial))
        makerChatStore.updateSystemCardData(sessionId, completionId, { ...next });
    } catch (error) {
      if (current()) {
        const code = extractIpcError(error)?.message;
        setError({
          mode: action === 'build' || action === 'open-build' ? 'build' : 'test',
          code: code === 'changed' || code === 'environment' ? code : 'unavailable',
        });
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(undefined);
    }
  };
  const buildMode =
    pending === 'build' ||
    pending === 'open-build' ||
    (pending !== 'start' &&
      (error?.mode ?? meta.lastAction ?? (meta.personal ? 'build' : 'test')) === 'build');
  const testStatus = pending === 'start' ? 'starting' : (meta.test?.status ?? 'waiting');
  const buildStatus = pending === 'build' ? 'waiting' : meta.personal?.status;
  const building = ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(
    buildStatus ?? '',
  );
  const starting = testStatus === 'starting';
  const switching = !!versions.pending || versions.state?.switching === true;
  const usingPersonal =
    !!meta.personal?.versionId && versions.state?.currentId === meta.personal.versionId;
  const working = buildMode ? building : starting;
  const errorCode =
    starting || building
      ? undefined
      : (error?.code ??
        (buildMode ? meta.personal?.error : meta.test?.error) ??
        (!meta.commit ? 'unavailable' : undefined));
  return (
    <CindyMakeCompleteCard
      composer
      data={{ ...meta }}
      busy={working}
      failed={Boolean(errorCode)}
      heading={t(
        buildMode && buildStatus
          ? buildStatus === 'checking' && meta.personal?.checkStep
            ? 'cindyMake.personal.checkStep.' + meta.personal.checkStep
            : 'cindyMake.personal.status.' + buildStatus
          : 'cindyMake.test.status.' + testStatus,
      )}
      description={t(
        buildMode && buildStatus === 'ready'
          ? meta.personal?.versionId
            ? 'cindyMake.versions.readyHint'
            : 'cindyMake.personal.readyHint'
          : buildMode && building
            ? 'cindyMake.personal.description'
            : testStatus === 'ready'
              ? 'cindyMake.test.readyHint'
              : 'cindyMake.test.description',
        { name: meta.personal?.artifactName ?? '' },
      )}
    >
      {versions.error && (
        <p role="alert" className="text-12 text-[var(--status-danger)]">
          {t('cindyMake.versions.errors.' + versions.error)}
        </p>
      )}
      {errorCode && (
        <p role="alert" className="text-12 text-[var(--status-danger)]">
          {t((buildMode ? 'cindyMake.personal.errors.' : 'cindyMake.test.errors.') + errorCode)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={!!pending || building || switching}
          loading={pending === 'continue'}
          onClick={() => void act('continue')}
        >
          {t('cindyMake.test.continue')}
        </Button>
        <Button
          variant="secondary"
          disabled={
            !!pending || building || starting || switching || testStatus === 'ready' || !meta.commit
          }
          loading={starting}
          onClick={() => void act('start')}
        >
          {t(testStatus === 'ready' ? 'cindyMake.test.started' : 'cindyMake.test.start')}
        </Button>
        <Button
          variant="secondary"
          disabled={!!pending || building || starting || switching || usingPersonal || !meta.commit}
          loading={building || switching || pending === 'open-build'}
          onClick={() => {
            if (meta.personal?.status === 'ready' && meta.personal.versionId)
              void versions.act('switch', meta.personal.versionId);
            else void act(meta.personal?.status === 'ready' ? 'open-build' : 'build');
          }}
        >
          {t(
            meta.personal?.status === 'ready'
              ? usingPersonal
                ? 'cindyMake.versions.using'
                : meta.personal.versionId
                  ? 'cindyMake.versions.switchPersonal'
                  : 'cindyMake.personal.open'
              : 'cindyMake.personal.generate',
          )}
        </Button>
      </div>
    </CindyMakeCompleteCard>
  );
}
