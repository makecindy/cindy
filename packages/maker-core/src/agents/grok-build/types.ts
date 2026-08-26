/**
 * Agent Client Protocol (ACP) types used by Grok Build (`grok agent stdio`).
 *
 * JSON-RPC 2.0 **with** `jsonrpc: "2.0"` (unlike Codex app-server, which omits it).
 * Spec: https://agentclientprotocol.com — grok-build session `_meta` is a vendor
 * extension (`yoloMode` / `autoMode` / `rules` / `systemPromptOverride`).
 */

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_JSONRPC_VERSION = '2.0' as const;

export type AcpJsonRpcId = number | string;

export interface AcpJsonRpcRequest {
  jsonrpc: typeof ACP_JSONRPC_VERSION;
  id: AcpJsonRpcId;
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcNotification {
  jsonrpc: typeof ACP_JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcSuccess {
  jsonrpc: typeof ACP_JSONRPC_VERSION;
  id: AcpJsonRpcId;
  result: unknown;
}

export interface AcpJsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpJsonRpcFailure {
  jsonrpc: typeof ACP_JSONRPC_VERSION;
  id: AcpJsonRpcId;
  error: AcpJsonRpcErrorObject;
}

export type AcpIncomingMessage =
  | AcpJsonRpcRequest
  | AcpJsonRpcNotification
  | AcpJsonRpcSuccess
  | AcpJsonRpcFailure;

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientInfo?: AcpClientInfo;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string; title?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
  };
  authMethods?: AcpAuthMethod[];
}

export interface AcpSessionNewMeta {
  yoloMode?: boolean;
  autoMode?: boolean;
  rules?: string;
  systemPromptOverride?: string;
  agentProfile?: string | Record<string, unknown>;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: unknown[];
  _meta?: AcpSessionNewMeta;
}

export interface AcpSessionNewResult {
  sessionId: string;
}

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: unknown }
  | { type: 'resource_link'; uri: string; name?: string };

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpSessionPromptResult {
  stopReason: AcpStopReason;
}

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  locations?: Array<{ path: string }>;
  content?: unknown[];
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
}

export type AcpSessionUpdate =
  | {
      sessionUpdate: 'agent_message_chunk';
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: 'agent_thought_chunk';
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: 'user_message_chunk';
      content: AcpContentBlock;
    }
  | ({
      sessionUpdate: 'tool_call';
    } & AcpToolCall)
  | ({
      sessionUpdate: 'tool_call_update';
    } & Partial<AcpToolCall> & { toolCallId: string })
  | {
      sessionUpdate: 'plan';
      entries?: unknown[];
    }
  | {
      sessionUpdate: 'usage_update';
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      cachedTokens?: number;
    }
  | {
      sessionUpdate: string;
      [key: string]: unknown;
    };

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpPermissionResponse {
  outcome: AcpPermissionOutcome;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseIncomingMessage(value: unknown): AcpIncomingMessage | null {
  if (!isRecord(value) || value.jsonrpc !== ACP_JSONRPC_VERSION) return null;
  const hasId = 'id' in value;
  const hasMethod = typeof value.method === 'string';
  if (hasMethod && hasId) {
    return value as unknown as AcpJsonRpcRequest;
  }
  if (hasMethod && !hasId) {
    return value as unknown as AcpJsonRpcNotification;
  }
  if (hasId && 'result' in value) {
    return value as unknown as AcpJsonRpcSuccess;
  }
  if (hasId && isRecord(value.error)) {
    return value as unknown as AcpJsonRpcFailure;
  }
  return null;
}
