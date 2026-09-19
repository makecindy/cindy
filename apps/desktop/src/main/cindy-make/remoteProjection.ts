import type { RemoteResource, RemoteActionDescriptor } from '@cindy/device-link';
import type { MakeDoctorReport } from '../../shared/cindyMakeDoctor.js';
import type {
  CindyMakeCompletionMeta,
  CindyMakePersonalBuildState,
} from '../../shared/cindyMakeSession.js';

export const MAKE_REMOTE_COLLECTION = 'cindy-make';
export const makeRemoteRef = (sessionId: string) => ({
  collectionId: MAKE_REMOTE_COLLECTION,
  kind: 'session',
  id: sessionId,
});
export interface MakeRemoteSnapshot {
  sessionId: string;
  revision: string;
  busy: boolean;
  preparation?: MakeDoctorReport;
  completion?: { id: string; meta: CindyMakeCompletionMeta };
  sharedBuild?: CindyMakePersonalBuildState;
  recoverable: boolean;
}
type Translate = (key: string, values?: Record<string, string>) => string;

/** Portable projection of Main-owned facts. Paths, prompts and process output stay on the host. */
export function projectMakeRemoteCard(source: MakeRemoteSnapshot, t: Translate): RemoteResource {
  let title = t('cindyMake.history.lifecycle.running');
  let description = '';
  let blocked = false;
  let busy = source.busy;
  let failed = false;
  const details: string[] = [];
  const actions: RemoteActionDescriptor[] = [];
  const action = (id: string, key: string, disabled = false) =>
    actions.push({ id, label: t(key), disabled });
  const prep = source.preparation;
  if (
    prep &&
    prep.status !== 'completed' &&
    !(prep.status === 'running' && prep.task?.phase === 'completed')
  ) {
    blocked = true;
    busy = prep.status === 'running';
    failed = prep.status === 'failed';
    title = t(
      busy
        ? 'cindyMake.code.phases.' + (prep.task?.phase ?? 'waiting')
        : failed
          ? 'cindyMake.code.preparationFailed'
          : 'cindyMake.prepare.cancelled',
    );
    description = t(busy ? 'cindyMake.code.inputLocked.hint' : 'cindyMake.code.inputLocked.retry');
    for (const check of prep.checks) {
      if (['passed', 'pending'].includes(check.status)) continue;
      let detail =
        t('cindyMakeDoctor.checks.' + check.id) +
        ': ' +
        t('cindyMakeDoctor.checkStatus.' + check.status);
      if (check.progress?.percent != null && Number.isFinite(check.progress.percent))
        detail += ' ' + Math.round(check.progress.percent) + '%';
      details.push(detail);
      if (check.reason === 'timeout') details.push(t('cindyMakeDoctor.timeout'));
      else if (
        check.reason &&
        ['downloadFailed', 'checksum', 'installFailed'].includes(check.reason)
      )
        details.push(t('cindyMake.prepare.errors.' + check.reason));
    }
    const progress = prep.task?.dependencies;
    if (progress)
      details.push(
        t(
          'cindyMake.code.dependencyProgress',
          Object.fromEntries(
            ['resolved', 'reused', 'downloaded', 'added'].map((key) => [
              key,
              String(progress[key as keyof typeof progress] ?? 0),
            ]),
          ),
        ),
      );
    if (prep.source?.error) details.push(t('cindyMake.source.errors.' + prep.source.error));
    action(
      `prepare:${prep.runId}:${busy ? 'stop' : 'retry'}`,
      busy ? 'cindyMake.history.stop' : 'cindyMake.history.actions.retry-prepare',
    );
  } else if (!source.busy && source.completion && !source.completion.meta.continuedAt) {
    blocked = true;
    const { id, meta } = source.completion;
    const testStatus = meta.test?.status ?? 'waiting';
    const shared = source.sharedBuild;
    const personal =
      shared?.buildId === meta.personal?.buildId &&
      meta.personal &&
      ['ready', 'failed'].includes(meta.personal.status)
        ? meta.personal
        : (shared ?? meta.personal);
    const building =
      !!personal &&
      ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(personal.status);
    const starting = testStatus === 'starting';
    const buildMode =
      !starting &&
      ((!!shared && (building || meta.lastAction !== 'test')) ||
        (meta.lastAction ?? (meta.personal ? 'build' : 'test')) === 'build');
    busy = buildMode ? building : starting;
    const error =
      starting || building
        ? undefined
        : ((buildMode ? personal?.error : meta.test?.error) ??
          (!meta.commit ? 'unavailable' : undefined));
    failed = !!error;
    title = t(
      buildMode && personal
        ? personal.stopping
          ? 'cindyMake.history.stopping'
          : personal.status === 'checking' && personal.checkStep
            ? 'cindyMake.personal.checkStep.' + personal.checkStep
            : 'cindyMake.personal.status.' + personal.status
        : 'cindyMake.test.status.' + testStatus,
    );
    description = t(
      buildMode && building
        ? 'cindyMake.personal.description'
        : buildMode && personal?.status === 'ready'
          ? 'cindyMake.versions.readyHint'
          : starting
            ? 'cindyMake.test.startingHint'
            : testStatus === 'ready'
              ? 'cindyMake.test.readyHint'
              : 'cindyMake.test.description',
    );
    if (!buildMode && (starting || (meta.test?.step && meta.test.error)))
      details.push(
        t(starting ? 'cindyMake.test.currentStep' : 'cindyMake.test.failedStep', {
          step: t('cindyMake.test.steps.' + (meta.test?.step ?? 'waiting')),
        }),
      );
    if (error)
      details.push(
        t((buildMode ? 'cindyMake.personal.errors.' : 'cindyMake.test.errors.') + error),
      );
    action(`test:${id}:continue`, 'cindyMake.test.continue', starting || building);
    action(
      `test:${id}:start`,
      testStatus === 'ready'
        ? 'cindyMake.test.started'
        : ['failed', 'stopped'].includes(testStatus)
          ? 'cindyMake.test.retry'
          : 'cindyMake.test.start',
      starting || building || testStatus === 'ready' || !meta.commit,
    );
    action(`test:${id}:build`, 'cindyMake.personal.generate', starting || building || !meta.commit);
    if (building && personal?.buildId)
      action(
        `build:${personal.buildId}:stop`,
        personal.stopping ? 'cindyMake.history.stopping' : 'cindyMake.history.stop',
        !!personal.stopping,
      );
  } else if (!source.busy && source.recoverable) {
    title = t('cindyMake.test.resume.title');
    description = t('cindyMake.test.resume.description');
    action(`resume:${source.revision}`, 'cindyMake.test.resume.action');
  }
  const fallbackMarkdown = [title, description, ...details].filter(Boolean).join('\n\n');
  return {
    ref: makeRemoteRef(source.sessionId),
    revision: source.revision,
    display: {
      title,
      subtitle: description,
      status: { label: title, tone: failed ? 'critical' : busy ? 'warning' : 'neutral' },
    },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: source.sessionId } }],
    blocks:
      blocked || (!source.busy && source.recoverable)
        ? [
            {
              id: 'workflow',
              primitive: 'session-controls',
              fallbackMarkdown,
              data: { input: blocked ? 'blocked' : 'available', busy },
            },
          ]
        : [],
    actions,
  };
}
