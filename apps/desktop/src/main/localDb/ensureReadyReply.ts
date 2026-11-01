import { performance } from 'node:perf_hooks';

import { issueLocalDbFatalDetails } from './fatalDetailsClipboard.js';

export type EnsureReadyReply =
  | { ready: true }
  | { ready: false; error: { code: string; message: string } };

interface EnsureReadyReplyDeps {
  run: (userId: string) => Promise<EnsureReadyReply>;
  record: (result: EnsureReadyReply) => void;
  log: { info: (line: string) => void; warn: (line: string) => void; error: (line: string) => void };
}

/**
 * The `local-db:ensure-ready` reply. Every failed result returned to the renderer, including the
 * invalid-userId rejection and a thrown startup error, is registered as Main-issued clipboard text
 * so the fatal screen's copy action can write exactly the details it shows.
 */
export async function replyToEnsureReady(userId: unknown, deps: EnsureReadyReplyDeps): Promise<EnsureReadyReply> {
  const { run, record, log } = deps;
  const startedAt = performance.now();
  const finish = (result: EnsureReadyReply): EnsureReadyReply => {
    record(result);
    // 致命界面的「复制技术细节」走主进程剪贴板，只接受 Main 签发的文本：返回前登记同一份细节串。
    issueLocalDbFatalDetails(result);
    return result;
  };
  log.info(JSON.stringify({
    event: 'localDb.ipc.ensure-ready.recv',
    userId: typeof userId === 'string' ? userId : `<${typeof userId}>`,
  }));
  if (typeof userId !== 'string' || !userId) {
    log.warn(JSON.stringify({ event: 'localDb.ipc.ensure-ready.reject', reason: 'invalid userId' }));
    return finish({ ready: false, error: { code: 'DB_INIT_FAILED', message: 'invalid userId' } });
  }
  let result: EnsureReadyReply;
  try {
    result = await run(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(JSON.stringify({ event: 'localDb.ipc.ensure-ready.failed', userId, error: message }));
    result = { ready: false, error: { code: 'DB_INIT_FAILED', message } };
  }
  finish(result);
  log.info(JSON.stringify({
    event: 'localDb.ipc.ensure-ready.done',
    userId,
    ready: result.ready,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...(result.ready ? {} : { error: result.error }),
  }));
  return result;
}
