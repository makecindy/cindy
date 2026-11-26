/**
 * Codex 本地 app-server 的 PID → 职责注册表。
 *
 * 职责来自 maker-core 创建 host 时已经确定的 hostPurpose，不从命令行、proxy
 * endpoint 或凭据模式反推。注册表只驻留 main 内存；renderer 只收到共享契约里的
 * 枚举，不会看到内部 host key、URL 或启动参数。
 */

import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AgentProcessRole } from '../../shared/processMonitor.js';
import type { MonitoredAgentKind } from './agent-scan.js';

interface Registration {
  kind: MonitoredAgentKind;
  role: AgentProcessRole;
  /** 承载的宿主 session id；Codex 共享服务与未知归属为 null。 */
  sessionId: string | null;
  instanceId: string;
  identity: symbol;
  codexChild?: ChildProcess;
}

const registrations = new Map<number, Registration>();

export interface AgentProcessRegistration {
  kind: MonitoredAgentKind;
  role: AgentProcessRole;
  sessionId: string | null;
  instanceId: string;
}

export function registerAgentProcess(
  pid: number,
  kind: MonitoredAgentKind,
  role: AgentProcessRole,
  sessionId?: string | null,
  codexChild?: ChildProcess,
): () => void {
  const identity = Symbol(`${kind}-process-${pid}`);
  registrations.set(pid, {
    kind,
    role,
    sessionId: sessionId ?? null,
    instanceId: randomUUID(),
    identity,
    codexChild,
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // PID 可能已被复用并重新登记；旧 disposer 不能删掉新进程的职责。
    if (registrations.get(pid)?.identity === identity) registrations.delete(pid);
  };
}

export function registerCodexProcessRole(pid: number, role: AgentProcessRole, child?: ChildProcess): () => void {
  return registerAgentProcess(pid, 'codex', role, null, child);
}

export function resolveAgentProcessRegistration(pid: number): AgentProcessRegistration | null {
  const registration = registrations.get(pid);
  if (!registration) return null;
  return {
    kind: registration.kind,
    role: registration.role,
    sessionId: registration.sessionId,
    instanceId: registration.instanceId,
  };
}

/** 当前仍登记的本地 Codex app-server PID。登记本身不提供发信号的权限。 */
export function listCodexProcessPids(): number[] {
  const pids: number[] = [];
  for (const [pid, registration] of registrations) {
    if (registration.kind === 'codex') pids.push(pid);
  }
  return pids;
}

/** Only the original registered spawn can authorize a quit-time tree walk. */
export function listCodexProcessReapTargets(): Array<{ pid: number; isCurrent: () => boolean }> {
  return listCodexProcessPids().map(pid => {
    const registration = registrations.get(pid)!;
    const child = registration.codexChild;
    return {
      pid,
      isCurrent: () => registrations.get(pid) === registration && child instanceof ChildProcess
        && child.pid === pid && !!child.spawnfile && !child.killed
        && child.exitCode === null && child.signalCode === null,
    };
  });
}

export function resolveCodexProcessRole(pid: number): AgentProcessRole | null {
  const registration = registrations.get(pid);
  return registration?.kind === 'codex' ? registration.role : null;
}

/** 仅测试用。 */
export function _resetCodexProcessRegistryForTests(): void {
  registrations.clear();
}
