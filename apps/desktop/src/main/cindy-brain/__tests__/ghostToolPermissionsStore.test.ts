/**
 * ghostToolPermissionsStore.test.ts — 插件工具授权存储单测
 */

import { describe, expect, it } from 'vitest';
import {
  readGhostToolPermissions,
  resolveToolApprovalMode,
  writeGhostToolPermissions,
} from '../ghostToolPermissionsStore';

describe('ghostToolPermissionsStore', () => {
  it('defaults to needs-approval when no configuration is set', () => {
    const mode = resolveToolApprovalMode('test-ghost-1', 'some_tool');
    expect(mode).toBe('needs-approval');
  });

  it('saves and resolves global policy correctly', () => {
    writeGhostToolPermissions('test-ghost-2', {
      globalPolicy: 'always-allow',
    });

    const read = readGhostToolPermissions('test-ghost-2');
    expect(read.globalPolicy).toBe('always-allow');

    const mode = resolveToolApprovalMode('test-ghost-2', 'any_tool');
    expect(mode).toBe('always-allow');
  });

  it('per-tool override takes precedence over global policy', () => {
    writeGhostToolPermissions('test-ghost-3', {
      globalPolicy: 'always-allow',
      tools: {
        sensitive_tool: 'blocked',
        ask_tool: 'needs-approval',
      },
    });

    expect(resolveToolApprovalMode('test-ghost-3', 'sensitive_tool')).toBe('blocked');
    expect(resolveToolApprovalMode('test-ghost-3', 'ask_tool')).toBe('needs-approval');
    expect(resolveToolApprovalMode('test-ghost-3', 'normal_tool')).toBe('always-allow');
  });

  it('normalizes invalid mode values gracefully', () => {
    writeGhostToolPermissions('test-ghost-4', {
      globalPolicy: 'invalid_value',
      tools: {
        tool_a: 'invalid_mode',
        tool_b: 'blocked',
      },
    });

    const read = readGhostToolPermissions('test-ghost-4');
    expect(read.globalPolicy).toBeUndefined();
    expect(read.tools).toEqual({ tool_b: 'blocked' });
  });
});
