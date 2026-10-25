import type {InvokeResultPayload} from '@cindy/device-link';
import {readChatHistoryMessages} from './remoteChatHistory.js';
import {historyContentText} from './taskDigest.js';
type Invoke=(deviceId:string,channel:string,args:unknown[])=>Promise<InvokeResultPayload>;
export async function readRemoteMessageItems(invoke: Invoke, deviceId: string, sessionId: string, limit: number) {
  const result = await readChatHistoryMessages(
    {
      sessionIds: [`${deviceId}::${sessionId}`],
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: ['user', 'assistant'],
      includeRewound: false,
      limit,
      cursor: null,
      order: 'desc',
    },
    {
      readLocal: async () => {
        throw new Error('local read not expected');
      },
      invokeRemote: invoke,
    },
  );
  if (!result.ok) return result;
  return {
    ok: true as const,
    items: result.page.items
      .slice()
      .reverse()
      .map((message) => ({
        role: (message.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: historyContentText(message.content),
        at: message.createdAt,
      })),
  };
}

/** 工作台跨电脑读取用:那台电脑上一件任务最近的用户 / 助手文字(时间正序)。 */
export function createRemoteWorkbenchMessageReader(invoke: Invoke) {
  return async (deviceId: string, sessionId: string) => {
    const result = await readRemoteMessageItems(invoke, deviceId, sessionId, 60);
    return result.ok ? result : { ok: false as const, errorCode: result.errorCode, message: result.message };
  };
}

