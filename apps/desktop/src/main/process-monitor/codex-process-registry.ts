/**
 * Codex 本地 app-server 的 PID → 职责注册表。
 *
 * 职责来自 maker-core 创建 host 时已经确定的 hostPurpose，不从命令行、proxy
 * endpoint 或凭据模式反推。注册表只驻留 main 内存；renderer 只收到共享契约里的
 * 枚举，不会看到内部 host key、URL 或启动参数。
 */

import type { AgentProcessRole } from '../../shared/processMonitor.js';

interface Registration {
  role: AgentProcessRole;
  identity: symbol;
}

const registrations = new Map<number, Registration>();

export function registerCodexProcessRole(pid: number, role: AgentProcessRole): () => void {
  const identity = Symbol(`codex-process-${pid}`);
  registrations.set(pid, { role, identity });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // PID 可能已被复用并重新登记；旧 disposer 不能删掉新进程的职责。
    if (registrations.get(pid)?.identity === identity) registrations.delete(pid);
  };
}

export function resolveCodexProcessRole(pid: number): AgentProcessRole | null {
  return registrations.get(pid)?.role ?? null;
}

/** 仅测试用。 */
export function _resetCodexProcessRegistryForTests(): void {
  registrations.clear();
}
