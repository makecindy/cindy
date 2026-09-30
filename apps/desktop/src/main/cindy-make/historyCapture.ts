import type { MakeDoctorReport } from '../../shared/cindyMakeDoctor.js';
import type { CindyMakeCompletionMeta } from '../../shared/cindyMakeSession.js';
import type { CindyMakeHistoryStore } from './historyStore.js';
import { captureMakeHistoryStore } from './historyOwner.js';

/** Save only typed product facts, never transcript content or a working-directory copy. */
export function captureMakeHistoryReport(
  report: MakeDoctorReport,
  store = captureMakeHistoryStore(),
  createdAt = Date.now(),
): void {
  if (!report.task) return;
  store.seed({
    runId: report.runId,
    sessionId: report.task.sessionId,
    title: report.task.title ?? '',
    request: report.task.request ?? '',
    createdAt,
    updatedAt: createdAt,
    ...(report.task.finished ? { endedAt: createdAt } : {}),
  });
}
export function captureMakeHistoryCompletion(
  store: CindyMakeHistoryStore,
  runId: string,
  id: string,
  meta: CindyMakeCompletionMeta,
): void {
  store.completion(runId, { ...meta, id });
  if (meta.personal?.status === 'ready' && meta.personal.commit) {
    for (const feature of meta.personal.includedFeatures ?? [])
      store.version(feature.runId, {
        operationId: feature.operationId,
        commit: meta.personal.commit,
        versionId: meta.personal.versionId,
        at: meta.personal.generatedAt,
      });
  }
}
