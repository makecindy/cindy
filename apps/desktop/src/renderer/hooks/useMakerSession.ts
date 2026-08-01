/**
 * useMakerSession — maker-experimental 诊断页的最小会话 hook。
 *
 * 本 hook 只暴露最小能力（create/send/abort/close + 事件 list），
 * 配合 /maker-experimental 诊断 Maker IPC 与 agent event 链路。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface MakerEvent {
  type: string;
  data: unknown;
  source?: string;
}

interface SessionInfo {
  sessionId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  workDir: string;
  capabilities: unknown;
}

interface CreateSessionParams {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workingDir: string;
  model: string;
  /** 与 maker-core/types/common.ts 的 Effort union 一致 */
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode?: boolean;
  permissionMode?: 'ask' | 'auto' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
  systemPrompt?: string;
  displayReasoning?: 'off' | 'summarized' | 'full';
}

type MakerSendResult = { accepted: boolean };

export interface UseMakerSession {
  session: SessionInfo | null;
  events: Array<{ id: number; sessionId: string; event: MakerEvent }>;
  status: string;
  error: string | null;
  isReady: boolean;
  createSession: (params: CreateSessionParams) => Promise<void>;
  send: (text: string, attachments?: Array<{ type: 'image' | 'file'; path: string; mimeType?: string }>) => Promise<MakerSendResult>;
  abort: () => Promise<void>;
  close: () => Promise<void>;
  clearEvents: () => void;
}

interface MakerApi {
  createSession: (opts: CreateSessionParams & { title?: string }) => Promise<SessionInfo>;
  send: (sid: string, message: { type: 'user'; content: unknown }) => Promise<MakerSendResult>;
  abortSession: (sid: string) => Promise<void>;
  closeSession: (sid: string) => Promise<void>;
  onEvent: (cb: (data: unknown) => void) => () => void;
  onStatusChanged: (cb: (data: unknown) => void) => () => void;
  onInteractionRequest: (cb: (data: unknown) => void) => () => void;
  onInteractionDismissed: (cb: (data: unknown) => void) => () => void;
  resolveInteraction: (
    requestId: string,
    // InteractionDecision union (permission/ask_user_question/plan_review)
    decision: Record<string, unknown>,
  ) => Promise<void>;
}

function getMakerApi(): MakerApi | null {
  const api = (window as unknown as { electronAPI?: { maker?: MakerApi } }).electronAPI?.maker;
  return api ?? null;
}

export function useMakerSession(): UseMakerSession {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<Array<{ id: number; sessionId: string; event: MakerEvent }>>([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);
  const eventIdRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const api = getMakerApi();
  const isReady = api !== null;

  // 订阅事件：只关注本 session
  useEffect(() => {
    if (!api) return;
    const off = api.onEvent((data: unknown) => {
      const payload = data as { sessionId: string; event: MakerEvent };
      if (sessionIdRef.current && payload.sessionId !== sessionIdRef.current) return;
      eventIdRef.current += 1;
      setEvents((prev) => [...prev, { id: eventIdRef.current, ...payload }]);
    });
    return off;
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const off = api.onStatusChanged((data: unknown) => {
      const payload = data as { sessionId: string; status: string };
      if (sessionIdRef.current && payload.sessionId !== sessionIdRef.current) return;
      setStatus(payload.status);
    });
    return off;
  }, [api]);

  // interaction request 自动处理(一阶段实验页不接 UI):
  // - permission: deny
  // - ask_user_question: 空 answers
  // - plan_review: deny
  // 实际产品 chat 走 makerChatStore + useCCAgentChat 弹真 UI; 实验页只做 IPC 验证。
  useEffect(() => {
    if (!api) return;
    const off = api.onInteractionRequest((data: unknown) => {
      const payload = data as { sessionId: string; request: { requestId: string; kind?: string } };
      if (sessionIdRef.current && payload.sessionId !== sessionIdRef.current) return;
      const kind = payload.request.kind ?? 'permission';
      const decision = kind === 'ask_user_question'
        ? { kind: 'ask_user_question', answers: {} }
        : { kind, behavior: 'deny', reason: 'maker-experimental: interactive UI not wired' };
      void api.resolveInteraction(payload.request.requestId, decision);
    });
    return off;
  }, [api]);

  const createSession = useCallback(async (params: CreateSessionParams) => {
    if (!api) throw new Error('window.electronAPI.maker not available');
    setError(null);
    setEvents([]);
    eventIdRef.current = 0;
    try {
      const info = await api.createSession({ ...params, title: 'Maker Experimental' });
      sessionIdRef.current = info.sessionId;
      setSession(info);
      setStatus('active');
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, [api]);

  const send = useCallback(async (
    text: string,
    attachments?: Array<{ type: 'image' | 'file'; path: string; mimeType?: string }>,
  ) => {
    if (!api) throw new Error('maker api not available');
    if (!sessionIdRef.current) throw new Error('no active session');
    const content = attachments && attachments.length > 0
      ? [
          { type: 'text', text },
          ...attachments.map((a) => ({ type: a.type, path: a.path, mimeType: a.mimeType })),
        ]
      : text;
    const result = await api.send(sessionIdRef.current, { type: 'user', content });
    return result;
  }, [api]);

  const abort = useCallback(async () => {
    if (!api || !sessionIdRef.current) return;
    await api.abortSession(sessionIdRef.current);
  }, [api]);

  const close = useCallback(async () => {
    if (!api || !sessionIdRef.current) return;
    await api.closeSession(sessionIdRef.current);
    sessionIdRef.current = null;
    setSession(null);
    setStatus('closed');
  }, [api]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    eventIdRef.current = 0;
  }, []);

  return {
    session,
    events,
    status,
    error,
    isReady,
    createSession,
    send,
    abort,
    close,
    clearEvents,
  };
}
