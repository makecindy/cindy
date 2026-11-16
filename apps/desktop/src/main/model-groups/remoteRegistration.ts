/**
 * 把模型组接到设备互联：同账号其他电脑的 `model-groups:remote` 请求由这台的模式与选路实例回答
 * (model-groups.md「在另一台电脑上开的新任务」)。
 */
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { ModelGroupResolveRequest, ModelGroupResolveResult } from '../../shared/modelGroups.js';
import type { ModelGroupRemoteNote } from '../../shared/modelGroupsRemote.js';
import { setModelGroupsRemoteHandler } from '../device-link/dispatch.desktop.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages } from '../localDb/schema.js';
import { getSessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { handleModelGroupsRemote } from './remoteHandler.js';
import { readModelGroupsConfig } from './store.js';

const log = desktopMakerLogger.child('model-groups-remote');

/** 首条消息由发起端随后交给这台发送：最多等这么久(与本机写说明相同的 40 × 250ms)。 */
const NOTE_WAIT_ATTEMPTS = 40;
const NOTE_WAIT_STEP_MS = 250;

async function firstUserMessageAt(sessionId: string): Promise<number | null> {
  const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), isNull(messages.rewindAt)))
    .orderBy(asc(messages.createdAt)).limit(1);
  return row ? Number(row.createdAt) : null;
}

/** 与本机 writeModelGroupRouteNote 相同：等首条消息落库，把说明定在它之后 1ms；等不到就按现在写。 */
async function writeRemoteModelGroupNote(sessionId: string, note: ModelGroupRemoteNote): Promise<void> {
  if (!(await getSessionRowSnapshot(sessionId))) return;
  let createdAt: number | null = null;
  for (let attempt = 0; attempt < NOTE_WAIT_ATTEMPTS && createdAt === null; attempt += 1) {
    const userAt = await firstUserMessageAt(sessionId).catch(() => null);
    if (userAt !== null && Number.isFinite(userAt)) createdAt = userAt + 1;
    else await new Promise((resolve) => setTimeout(resolve, NOTE_WAIT_STEP_MS));
  }
  // 按需加载：消息写入模块很大，不为这条很少走到的路径把它拉进模型组的启动依赖。
  const { createMessage } = await import('../localDb/ipc/messages.js');
  await createMessage(sessionId, {
    clientId: `model-group-route:${sessionId}`,
    role: 'assistant',
    content: '',
    agentMeta: { pluginModelRoute: { ...note, source: 'model-group' } },
    ...(createdAt !== null ? { createdAt } : {}),
  });
}

export function registerModelGroupsRemoteHandler(resolver: {
  resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  commit(decisionId: string): boolean;
}): void {
  setModelGroupsRemoteHandler({
    handle: (raw) => handleModelGroupsRemote({
      config: readModelGroupsConfig,
      resolve: (request) => resolver.resolve(request),
      commit: (decisionId) => resolver.commit(decisionId),
      writeNote: writeRemoteModelGroupNote,
      warn: (message) => log.warn(message),
    }, raw),
  });
}
