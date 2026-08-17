/**
 * chat-data-localization F5：messageService 切层为 IPC（HTTP → IPC）。
 *
 * 函数签名与原 HTTP 版完全一致——上层调用零改动。
 */

import type { AgentMeta, Message, MessageRole } from '@/lib/ccAgent.types';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';
import type { RegionalMoney } from '../../shared/regionalMoney';
import type { SdkCostPresentation } from '../../shared/regionalMoney';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

export async function list(
  sessionId: string,
  opts?: { limit?: number; before?: string; beforeTs?: number },
): Promise<Message[]> {
  return wrap(window.electronAPI.localDb.messages.list(sessionId, opts));
}

export async function estimatedSessionValue(
  sessionId: string,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): Promise<{
  totalValueMoney?: RegionalMoney | null;
  totalValueUsd?: number;
  entries: Array<{
    clientId: string;
    money?: RegionalMoney;
    costUsd?: number;
    excludedActualMoney?: RegionalMoney;
    turnCostIsCustomProvider?: boolean;
    turnCostProviderId?: string | null;
    turnUsageDetails?: unknown;
  }>;
}> {
  return wrap(
    window.electronAPI.localDb.messages.estimatedSessionValue(
      sessionId,
      presentation,
      showSdkEstimate,
    ),
  );
}

export async function around(
  sessionId: string,
  messageId: string,
  opts?: { radius?: number },
): Promise<Message[]> {
  return wrap(window.electronAPI.localDb.messages.around(sessionId, messageId, opts));
}

export async function aroundClientId(
  sessionId: string,
  clientId: string,
  opts?: { radius?: number },
): Promise<Message[]> {
  return wrap(window.electronAPI.localDb.messages.aroundClientId(sessionId, clientId, opts));
}

export async function create(
  sessionId: string,
  body: {
    clientId: string;
    role: MessageRole;
    content: unknown;
    toolUseId?: string;
    createdAt?: string;
    /**
     * SDK 元信息（仅 cc 来源消息有）。可省略——renderer 当前调用方
     * 在不知道 SDK 字段时（比如 mid-turn 抢救 assistant 流式累积）传 undefined，
     * 由 main agentManager 在 SDK echo 路径上独立写入完整 cc 消息。
     */
    agentMeta?: AgentMeta | null;
  },
): Promise<Message> {
  return wrap(window.electronAPI.localDb.messages.create(sessionId, body));
}

export async function updateContent(
  sessionId: string,
  clientId: string,
  content: unknown,
): Promise<Message> {
  return wrap(window.electronAPI.localDb.messages.updateContent(sessionId, clientId, content));
}

/**
 * error-tail-banner:忽略(dismiss)一条 role='error' 行。main 侧读原 content 后
 * merge dismissed:true 写回 —— 不要在 renderer 用解析后的展示字段重建 content
 * (会丢 sdkError 等未透传字段)。
 */
export async function dismissError(sessionId: string, clientId: string): Promise<Message> {
  return wrap(window.electronAPI.localDb.messages.dismissError(sessionId, clientId));
}
