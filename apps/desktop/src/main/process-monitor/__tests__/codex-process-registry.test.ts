import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCodexProcessRegistryForTests,
  registerCodexProcessRole,
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
});
