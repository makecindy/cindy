/**
 * 手机或另一台电脑经这台电脑的模式建了任务后，由这台电脑在任务里写那一行说明(model-groups.md §6.3)。
 * 远程不能裸写消息，说明的文字由控制端按它的语言写好送来，这里只按不可信数据收下、找到首条消息再落库。
 * 本机界面仍在 renderer 里自己写(modelGroupsClient.writeModelGroupRouteNote)，两边同一个 clientId，重复写只留一行。
 */
import type { ModelGroupRouteNote } from '../../shared/modelGroups.js';
import { createLogger } from '../logger.js';

const log = createLogger('model-groups:route-note');

export interface ModelGroupRouteNotePorts {
  sessionExists(sessionId: string): Promise<boolean>;
  /** 这个任务第一条用户消息的落库时刻；还没有时为 null。 */
  firstUserMessageAt(sessionId: string): Promise<number | null>;
  createNote(sessionId: string, row: { clientId: string; createdAt?: number; note: ModelGroupRouteNote }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** 首条消息由 main 在开跑时才落库：最多等 10 秒，与本机界面写说明的等待相同。 */
const WAIT_ATTEMPTS = 40;
const WAIT_STEP_MS = 250;

export function modelGroupRouteNoteClientId(sessionId: string): string {
  return `model-group-route:${sessionId}`;
}

/**
 * 任务不存在时拒绝(返回 false)；存在就在后台写，调用方不用等首条消息落库。
 * 说明排在首条消息之后 1ms：在首条消息下面、回复上面。等不到首条消息时按现在的时间写。
 */
export async function acceptModelGroupRouteNote(
  ports: ModelGroupRouteNotePorts,
  sessionId: string,
  note: ModelGroupRouteNote,
): Promise<boolean> {
  if (!(await ports.sessionExists(sessionId))) return false;
  void (async () => {
    let createdAt: number | undefined;
    for (let attempt = 0; attempt < WAIT_ATTEMPTS && createdAt === undefined; attempt += 1) {
      const userAt = await ports.firstUserMessageAt(sessionId).catch(() => null);
      if (userAt !== null && Number.isFinite(userAt)) createdAt = userAt + 1;
      else await ports.sleep(WAIT_STEP_MS);
    }
    await ports.createNote(sessionId, {
      clientId: modelGroupRouteNoteClientId(sessionId),
      ...(createdAt !== undefined ? { createdAt } : {}),
      note,
    });
  })().catch((err: unknown) => log.warn('model group route note failed', {
    sessionId,
    err: err instanceof Error ? err.message : String(err),
  }));
  return true;
}
