/**
 * 会话引用解析器（桌面装配）。
 *
 * 解析主体在 sessionReferenceResolverCore.ts（不依赖 Electron，Node Host 共用）；
 * 这里接上桌面的 device-link：本机设备身份与对在线设备的远程读取。
 */
import type { AgentInputSessionRef, AgentInputSessionReferenceContext } from '../../shared/agentInputQueue.js';
import { getSelfDeviceId, remoteInvoke as invokeRemote } from '../device-link/index.js';
import { resolveSessionReferencesWithPorts } from './sessionReferenceResolverCore.js';

export {
  MAX_SESSION_REFERENCES,
  MAX_REFERENCE_MESSAGES,
  MAX_REFERENCE_TOKENS,
  SessionReferenceError,
  estimateReferenceTokens,
} from './sessionReferenceResolverCore.js';

/** 解析全部引用；超出数量或共享预算时明确报错/标记，不静默丢引用。 */
export async function resolveSessionReferences(
  refs: readonly AgentInputSessionRef[] | undefined,
  options?: { inlineMessageKeys?: ReadonlySet<string> },
): Promise<AgentInputSessionReferenceContext[]> {
  return resolveSessionReferencesWithPorts({ getSelfDeviceId, invokeRemote }, refs, options);
}
