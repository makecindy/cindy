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
  CindyMakePersonalBuildState,
} from '../../../shared/cindyMakeSession';
import { CindyMakeCompleteCard } from './CindyMakeCompleteCard';
import { CindyMakeBuildLog } from './CindyMakeBuildLog';
import { CindyMakeTestStep } from './CindyMakeTestStep';

type CompletedTestProps = {
  sessionId: string;
  completionId: string;
  meta: CindyMakeCompletionMeta;
  onContinue?: () => void;
};

type RecoveryTestProps = {
  sessionId: string;
  recovery: { onCheck: () => Promise<boolean | void>; onContinue: () => void };
};

/** Completion and missing-report recovery occupy the same composer card. */
export function CindyMakeTestCard(props: CompletedTestProps | RecoveryTestProps) {
  return 'recovery' in props ? (
    <CindyMakeTestRecovery {...props} />
  ) : (
    <CindyMakeCompletedTest {...props} />
  );
}

function CindyMakeTestRecovery({ sessionId, recovery }: RecoveryTestProps) {
  const { t } = useTranslation();
  const owner = getDataOwnerGeneration();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const current = () =>
    active.current && isDataOwnerGenerationCurrent(owner) && !getStickySessionDeviceId(sessionId);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const check = async () => {
    if (busy.current || !current()) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      const accepted = await recovery.onCheck();
      if (current() && accepted === false) setFailed(true);
    } catch {
      if (current()) setFailed(true);
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  };
  return (
    <CindyMakeCompleteCard
      composer
      needsCheck
      busy={pending}
      failed={failed}
      heading={t('cindyMake.test.resume.title')}
      description={t('cindyMake.test.resume.description')}
    >
      {failed && (
        <p role="alert" className="text-12 text-[var(--status-danger)]">
          {t('cindyMake.test.resume.failed')}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (!busy.current && current()) recovery.onContinue();
          }}
        >
          {t('cindyMake.test.continue')}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          loading={pending}
          onClick={() => void check()}
        >
          {t('cindyMake.test.resume.action')}
        </Button>
      </div>
    </CindyMakeCompleteCard>
  );
}

function CindyMakeCompletedTest({ sessionId, completionId, meta, onContinue }: CompletedTestProps) {
  const { t } = useTranslation();
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
      ? meta.personal
      : (sharedBuild ?? meta.personal);
  const versions = useCindyVersions(!!personal?.versionId, personal?.versionId);
  const [stoppingBuild, setStoppingBuild] = useState(false);
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
    if (busy.current || !current()) return;
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
  const buildStatus = pending === 'build' ? 'waiting' : personal?.status;
  const building = ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(
    buildStatus ?? '',
  );
  const starting = testStatus === 'starting';
  const buildMode =
    !starting &&
    ((!!sharedBuild && (building || meta.lastAction !== 'test')) ||
      pending === 'build' ||
      pending === 'open-build' ||
      (error?.mode ?? meta.lastAction ?? (meta.personal ? 'build' : 'test')) === 'build');
  const stopping = building && (stoppingBuild || personal?.stopping === true);
  const stopBuild = async () => {
    if (!personal?.buildId || stopping || !current()) return;
    setStoppingBuild(true);
    buildRequest.current += 1;
    try {
      const state = await window.electronAPI.cancelCindyMakePersonal(personal.buildId);
      if (current()) setSharedBuild(state.build);
    } catch {
      if (current()) setError({ mode: 'build', code: 'unavailable' });
    } finally {
      if (current()) setStoppingBuild(false);
    }
  };
  const switching = !!versions.pending || versions.state?.switching === true;
  const usingPersonal = !!personal?.versionId && versions.state?.currentId === personal.versionId;
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
      failed={Boolean(errorCode)}
      heading={t(
        buildMode && buildStatus
          ? stopping
            ? 'cindyMake.history.stopping'
            : buildStatus === 'waiting' && personal?.preparationStep
              ? 'cindyMake.personal.preparationStep.' + personal.preparationStep
              : buildStatus === 'checking' && personal?.checkStep
                ? 'cindyMake.personal.checkStep.' + personal.checkStep
                : 'cindyMake.personal.status.' + buildStatus
          : 'cindyMake.test.status.' + testStatus,
      )}
      description={t(
        buildMode && buildStatus === 'ready'
          ? personal?.versionId
            ? 'cindyMake.versions.readyHint'
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
          <CindyMakeBuildLog build={personal} openWhileActive={building || Boolean(errorCode)} />
        ) : (
          <CindyMakeTestStep
            test={pending === 'start' ? { status: 'starting', step: 'waiting' } : meta.test}
          />
        )
      }
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
          disabled={!!pending || building || starting || switching || usingPersonal || !meta.commit}
          loading={building || switching || pending === 'open-build'}
          onClick={() => {
            if (personal?.status === 'ready' && personal.versionId)
              void versions.act('switch', personal.versionId);
            else void act(personal?.status === 'ready' ? 'open-build' : 'build');
          }}
        >
          {t(
            personal?.status === 'ready'
              ? usingPersonal
                ? 'cindyMake.versions.using'
                : personal.versionId
                  ? 'cindyMake.versions.switchPersonal'
                  : 'cindyMake.personal.open'
              : 'cindyMake.personal.generate',
          )}
        </Button>
      </div>
    </CindyMakeCompleteCard>
  );
}
