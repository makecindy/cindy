/**
 * 任务导入给 Agent 工具（cindy_helper control 类）的回调：与设置页走同一套扫描与导入。
 */

import type { SessionImportCallbacks } from '@cindy/mcps';

import { importJob, latestImportJob, recoverInterruptedImports, startImport } from './executor.js';
import { scanImportSources } from './scan.js';
import type { ImportJobView } from './types.js';

function jobView(job: ImportJobView) {
  return {
    requestId: job.requestId,
    status: job.status,
    items: job.items.map((it) => ({
      key: it.key,
      source: it.source,
      title: it.title,
      status: it.status,
      mode: it.mode,
      harness: it.harness,
      issue: it.issue,
      sessionId: it.sessionId,
      messagesWritten: it.messagesWritten,
    })),
  };
}

export const sessionImportCallbacks: SessionImportCallbacks = {
  async scan({ force }) {
    void recoverInterruptedImports();
    const result = await scanImportSources(force);
    return {
      candidates: result.candidates.map((c) => ({
        key: c.key,
        source: c.source,
        title: c.title,
        cwd: c.cwd,
        project: c.dialogue ? null : c.groupKey,
        updatedAt: c.updatedAt,
        archived: c.archived,
        sizeBytes: c.sizeBytes,
        missingDir: c.missingDir,
        hidden: c.hidden,
        unsupportedVersion: c.unsupportedVersion,
      })),
      hiddenCounts: result.hiddenCounts,
      sources: result.sources,
      sourceErrors: result.sourceErrors,
    };
  },
  async start(keys) {
    return jobView(await startImport(keys));
  },
  async status(requestId) {
    await recoverInterruptedImports();
    const job = requestId ? importJob(requestId) : latestImportJob();
    return job ? jobView(job) : null;
  },
};
