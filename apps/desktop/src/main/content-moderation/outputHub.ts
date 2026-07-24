import type { AgentEvent } from '@cindy/maker-core';
import { OutputModerationGate } from './output.js';
import { emitOutputModerationSignal } from './signals.js';

interface SessionOutputSource {
  id: string;
  agentKind?: string;
  // 部分 host 测试替身保留宽松的 event shape；唯一 raw 边界在下方收窄为 AgentEvent。
  onEvent(listener: (event: any) => void): () => void;
  abort(): Promise<void>;
}

interface Hub {
  session: SessionOutputSource;
  gate: OutputModerationGate;
  listeners: Set<(event: AgentEvent) => void>;
  stopRaw: () => void;
}

const hubsBySession = new Map<string, Hub>();

function closeHub(hub: Hub): void {
  hub.stopRaw();
  hub.gate.close();
  hub.listeners.clear();
  if (hubsBySession.get(hub.session.id) === hub) {
    hubsBySession.delete(hub.session.id);
  }
}

function ensureHub(session: SessionOutputSource): Hub {
  const existing = hubsBySession.get(session.id);
  if (existing?.session === session) return existing;
  if (existing) closeHub(existing);

  const listeners = new Set<(event: AgentEvent) => void>();
  let hub: Hub;
  const gate = new OutputModerationGate({
    sessionId: session.id,
    agentKind: session.agentKind,
    deliver: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // 与 maker-core 原始多 listener 语义一致：单个消费者异常不阻断其他出口。
        }
      }
    },
    abortTurn: () => session.abort(),
    onBlocked: (turnId) => {
      emitOutputModerationSignal({ sessionId: session.id, turnId, kind: 'blocked' });
    },
    onFailed: () => undefined,
  });
  const stopRaw = session.onEvent((event: AgentEvent) => gate.handle(event));
  hub = { session, gate, listeners, stopRaw };
  hubsBySession.set(session.id, hub);
  return hub;
}

/**
 * 唯一允许正文消费者订阅的事件出口。每个 live session 只有这里持有 raw
 * `session.onEvent`，所有下游只会收到已 release 或 fail-open 的正文。
 */
export function onReleasedAgentEvent(
  session: SessionOutputSource,
  listener: (event: AgentEvent) => void,
): () => void {
  const hub = ensureHub(session);
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
    if (hub.listeners.size === 0) closeHub(hub);
  };
}

export function cancelReleasedOutput(sessionId: string): void {
  hubsBySession.get(sessionId)?.gate.cancel();
}

export function waitForReleasedOutput(sessionId: string): Promise<void> {
  return hubsBySession.get(sessionId)?.gate.waitForReleaseBoundary() ?? Promise.resolve();
}

export function cancelAllReleasedOutputs(): void {
  for (const hub of hubsBySession.values()) {
    if (hub.gate.cancel()) {
      void hub.session.abort().catch(() => undefined);
    }
  }
}

export function closeReleasedOutput(session: SessionOutputSource): void {
  const hub = hubsBySession.get(session.id);
  if (hub?.session === session) closeHub(hub);
}
