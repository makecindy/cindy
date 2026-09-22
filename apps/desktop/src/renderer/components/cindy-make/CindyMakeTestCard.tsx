import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { makerChatStore } from '@/lib/makerChatStore';
import { useCindyVersions } from '@/lib/useCindyVersions';
import { useCindyMakeState } from '@/lib/cindyMakeState';
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
  CindyMakePersonalBuildState,
} from '../../../shared/cindyMakeSession';
import { CindyMakeCompleteCard } from './CindyMakeCompleteCard';
import { CindyMakeBuildLog } from './CindyMakeBuildLog';
import { CindyMakeBuildProgress } from './CindyMakeBuildProgress';
import { CindyMakeBuildFailure } from './CindyMakeBuildFailure';
import { cindyMakeBuildStatusKey } from './cindyMakeBuildStatus';
import { CindyMakeTestStep } from './CindyMakeTestStep';
import { useCindyMakeBuildStop } from './useCindyMakeBuildStop';

type CompletedTestProps = {
  sessionId: string;
  completionId: string;
  meta: CindyMakeCompletionMeta;
  onContinue?: () => void;
};

export function CindyMakeTestCard({
  sessionId,
  completionId,
  meta,
  onContinue,
}: CompletedTestProps) {
  const { t } = useTranslation();
  const { upstreamMerge } = useCindyMakeState();
  const sourceMergePending =
    !!upstreamMerge &&
    upstreamMerge.status !== 'merged' &&
    (upstreamMerge.hasWorkspace || upstreamMerge.cancellationRequested);
  const owner = getDataOwnerGeneration();
  const [pending, setPending] = useState<Exclude<CindyMakeTestAction, 'status'>>();
  const [buildSnapshot, setBuildSnapshot] = useState<{
    owner: typeof owner;
    sessionId: string;
    completionId: string;
    build?: CindyMakePersonalBuildState;
  }>();
  const sharedBuild =
    buildSnapshot &&
    isDataOwnerGenerationCurrent(buildSnapshot.owner) &&
    buildSnapshot.sessionId === sessionId &&
    buildSnapshot.completionId === completionId
      ? buildSnapshot.build
      : undefined;
  const setSharedBuild = (build?: CindyMakePersonalBuildState) =>
    setBuildSnapshot({ owner, sessionId, completionId, build });
  const latestSharedBuild = useRef(sharedBuild);
  latestSharedBuild.current = sharedBuild;
  const personal =
    sharedBuild?.buildId === meta.personal?.buildId &&
    meta.personal &&
    ['ready', 'failed'].includes(meta.personal.status)
      ? {
          ...meta.personal,
          mergeSessionId: meta.personal.mergeSessionId ?? sharedBuild?.mergeSessionId,
        }
      : (sharedBuild ?? meta.personal);
  const versions = useCindyVersions(!!personal?.versionId, personal?.versionId);
  const { stop: confirmStopBuild, stopping: stoppingBuild } = useCindyMakeBuildStop(
    personal && !['ready', 'failed'].includes(personal.status) ? personal.buildId : undefined,
  );
  const buildRequest = useRef(0);
  const [error, setError] = useState<{
    mode: 'test' | 'build';
    code: CindyMakeTestState['error'];
  }>();
  const busy = useRef(false);
  const active = useRef(true);
  const version = useRef(0);
  const latest = useRef(meta);
  latest.current = meta;
  const current = () =>
    active.current && isDataOwnerGenerationCurrent(owner) && !getStickySessionDeviceId(sessionId);
  useEffect(() => {
    if (typeof window.electronAPI.getCindyMakeHistory !== 'function') return;
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (disposed || reading || !current() || document.visibilityState === 'hidden') return;
      reading = true;
      const request = ++buildRequest.current;
      try {
        const state = await window.electronAPI.getCindyMakeHistory();
        if (!disposed && current() && request === buildRequest.current) {
          const build = state.build;
          const previous = latestSharedBuild.current;
          if (
            build &&
            (!['ready', 'failed'].includes(build.status) ||
              (build.buildId &&
                (build.buildId === previous?.buildId ||
                  build.buildId === latest.current.personal?.buildId)))
          )
            setSharedBuild(build);
          else setSharedBuild(undefined);
        }
      } catch {
        /* The persisted completion remains available when refresh fails. */
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId, completionId, owner.dataOwnerId, owner.generation]);
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
    if (busy.current || !current() || (action === 'build' && sourceMergePending)) return;
    busy.current = true;
    version.current += 1;
    setPending(action);
    setError(undefined);
    if (action !== 'open-build') setSharedBuild(undefined);
    buildRequest.current += 1;
    const initial = latest.current;
    try {
      if (
        action === 'open-build' &&
        sharedBuild?.status === 'ready' &&
        sharedBuild.buildId !== meta.personal?.buildId
      ) {
        await window.electronAPI.openCindyMakeHistoryBuild();
        return;
      }
      const next = await window.electronAPI.cindyMakeTest(sessionId, completionId, action);
      if (current() && (action === 'continue' || latest.current === initial)) {
        if (action === 'continue') onContinue?.();
        makerChatStore.updateSystemCardData(sessionId, completionId, { ...next });
      }
    } catch (error) {
      if (current()) {
        const code = extractIpcError(error)?.message.replace(/^\[PRECONDITION_FAILED\]\s*/, '');
        setError({
          mode:
            code !== 'stopFailed' && (action === 'build' || action === 'open-build')
              ? 'build'
              : 'test',
          code:
            code === 'changed' || code === 'environment' || code === 'stopFailed'
              ? code
              : 'unavailable',
        });
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(undefined);
    }
  };
  const testStatus = pending === 'start' ? 'starting' : (meta.test?.status ?? 'waiting');
  const displayBuild: CindyMakePersonalBuildState | undefined =
    pending === 'build' ? { status: 'waiting' } : personal;
  const buildStatus = displayBuild?.status;
  const building = ['waiting', 'syncing', 'checking', 'merging', 'packaging', 'publishing'].includes(
    buildStatus ?? '',
  );
  const starting = testStatus === 'starting';
  const buildMode =
    !starting &&
    ((!!sharedBuild && (building || meta.lastAction !== 'test')) ||
      pending === 'build' ||
      pending === 'open-build' ||
      (error?.mode ?? meta.lastAction ?? (meta.personal ? 'build' : 'test')) === 'build');
  const stopping = building && (stoppingBuild || displayBuild?.stopping === true);
  const stopBuild = async () => {
    if (!personal?.buildId || stopping || !current()) return;
    await confirmStopBuild(
      current,
      (state) => {
        buildRequest.current += 1;
        setSharedBuild(state.build);
      },
      () => setError({ mode: 'build', code: 'unavailable' }),
    );
  };
  const switching = !!versions.pending || versions.state?.switching === true;
  const personalVersion = versions.state?.versions.find((version) => version.kind === 'personal');
  const generatesPersonal =
    personal?.status !== 'ready' || (!!personal.versionId && !!versions.state && !personalVersion);
  const usingPersonal =
    personal?.status === 'ready' &&
    !!personal.versionId &&
    !!personalVersion &&
    versions.state?.currentId === personalVersion.id &&
    !versions.state?.personalUpdateAvailable;
  const personalReadyHint = usingPersonal
    ? 'cindyMake.versions.usingHint'
    : versions.state?.personalUpdateAvailable
      ? 'cindyMake.versions.updateHint'
      : versions.state && !personalVersion
        ? 'cindyMake.versions.empty'
        : 'cindyMake.versions.readyHint';
  const working = buildMode ? building : starting;
  const errorCode =
    error?.code ??
    (starting || building
      ? undefined
      : ((buildMode ? personal?.error : meta.test?.error) ??
        (!meta.commit ? 'unavailable' : undefined)));
  return (
    <CindyMakeCompleteCard
      composer
      data={{ ...meta }}
      busy={working}
      failed={Boolean(errorCode) || (buildMode && buildStatus === 'failed')}
      heading={t(
        buildMode && displayBuild
          ? cindyMakeBuildStatusKey(displayBuild, stopping)
          : 'cindyMake.test.status.' + testStatus,
      )}
      description={t(
        buildMode && buildStatus === 'ready'
          ? personal?.versionId
            ? personalReadyHint
            : 'cindyMake.personal.readyHint'
          : buildMode && building
            ? 'cindyMake.personal.description'
            : starting
              ? 'cindyMake.test.startingHint'
              : testStatus === 'ready'
                ? 'cindyMake.test.readyHint'
                : 'cindyMake.test.description',
        { name: personal?.artifactName ?? '' },
      )}
      detail={
        buildMode ? (
          <div className="mt-3 space-y-3">
            <CindyMakeBuildProgress build={displayBuild} />
            <CindyMakeBuildFailure build={displayBuild} error={errorCode} />
            <CindyMakeBuildLog build={displayBuild} />
          </div>
        ) : (
          <CindyMakeTestStep
            test={pending === 'start' ? { status: 'starting', step: 'waiting' } : meta.test}
          />
        )
      }
    >
      {versions.error && (
        <p role="alert" className="text-12 text-[var(--error-fg)]">
          {t('cindyMake.versions.errors.' + versions.error)}
        </p>
      )}
      {errorCode && !buildMode && (
        <p role="alert" className="text-12 text-[var(--error-fg)]">
          {t('cindyMake.test.errors.' + errorCode)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {building && personal?.buildId && (
          <Button
            variant="secondary"
            disabled={stopping}
            loading={stopping}
            onClick={() => void stopBuild()}
          >
            {t(stopping ? 'cindyMake.history.stopping' : 'cindyMake.history.stop')}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={!!pending || building || starting || switching}
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
          disabled={
            !!pending ||
            building ||
            starting ||
            switching ||
            usingPersonal ||
            (generatesPersonal && sourceMergePending) ||
            !meta.commit ||
            (personal?.status === 'ready' && !!personal.versionId && !versions.state)
          }
          loading={building || switching || pending === 'open-build'}
          onClick={() => {
            if (personal?.status === 'ready' && personal.versionId) {
              if (personalVersion) void versions.act('switch', personalVersion.id);
              else if (versions.state) void act('build');
            } else void act(personal?.status === 'ready' ? 'open-build' : 'build');
          }}
        >
          {t(
            personal?.status === 'ready'
              ? usingPersonal
                ? 'cindyMake.versions.using'
                : personal.versionId
                  ? personalVersion || !versions.state
                    ? versions.state?.personalUpdateAvailable
                      ? 'cindyMake.versions.updatePersonal'
                      : 'cindyMake.versions.switchPersonal'
                    : 'cindyMake.personal.generate'
                  : 'cindyMake.personal.open'
              : 'cindyMake.personal.generate',
          )}
        </Button>
        {personal?.status === 'ready' && (
          <Button
            variant="secondary"
            disabled={!!pending || building || starting || switching || sourceMergePending || !meta.commit}
            loading={building || pending === 'build'}
            onClick={() => void act('build')}
          >
            {t('cindyMake.history.regeneratePersonal')}
          </Button>
        )}
      </div>
    </CindyMakeCompleteCard>
  );
}
