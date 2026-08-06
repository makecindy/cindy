import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCodexProcessRegistryForTests,
  registerAgentProcess,
  registerCodexProcessRole,
  resolveAgentProcessRegistration,
  resolveCodexProcessRole,
} from '../codex-process-registry.js';

beforeEach(() => {
  _resetCodexProcessRegistryForTests();
});

describe('codex process registry', () => {
  it('登记角色并在 disposer 时清理', () => {
    const dispose = registerCodexProcessRole(101, 'task-host');
    expect(resolveCodexProcessRole(101)).toBe('task-host');
    dispose();
    dispose();
    expect(resolveCodexProcessRole(101)).toBeNull();
  });

  it('PID 复用后旧 disposer 不会删除新登记', () => {
    const disposeOld = registerCodexProcessRole(101, 'task-host');
    const disposeNew = registerCodexProcessRole(101, 'control-plane-service');
    disposeOld();
    expect(resolveCodexProcessRole(101)).toBe('control-plane-service');
    disposeNew();
    expect(resolveCodexProcessRole(101)).toBeNull();
  });

  it('同一 PID 的每次实际 spawn 都获得不同 generation，旧 disposer 不影响新实例', () => {
    const disposeOld = registerAgentProcess(202, 'claude', 'task-host');
    const oldRegistration = resolveAgentProcessRegistration(202);
    const disposeNew = registerAgentProcess(202, 'claude', 'task-host');
    const newRegistration = resolveAgentProcessRegistration(202);

    expect(oldRegistration).toMatchObject({ kind: 'claude', role: 'task-host' });
    expect(newRegistration).toMatchObject({ kind: 'claude', role: 'task-host' });
    expect(newRegistration?.instanceId).not.toBe(oldRegistration?.instanceId);

    disposeOld();
    expect(resolveAgentProcessRegistration(202)).toEqual(newRegistration);
    disposeNew();
    expect(resolveAgentProcessRegistration(202)).toBeNull();
  });
});
