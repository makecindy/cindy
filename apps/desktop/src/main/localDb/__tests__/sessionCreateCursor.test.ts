import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sessionCreateToRow } from '../mapper.js';

describe('Cursor draft session creation', () => {
  it('allows the Cursor draft vendor through the IPC create gate', () => {
    const source = readFileSync(new URL('../ipc/sessions.ts', import.meta.url), 'utf8');
    const gate = source.match(/const ALLOWED_AGENT_KINDS = new Set<string>\(\[([^\]]+)\]\)/);
    expect(gate).not.toBeNull();
    expect(gate![1].match(/'[^']+'/g)).toEqual(["'cc'", "'codex'", "'pi'", "'cursor'"]);
  });
  it('uses the native Cursor default when no model was supplied', () => {
    expect(sessionCreateToRow('cursor-default', { agentKind: 'cursor' }, 1700000000000).model).toBe('cursor-default');
  });
  it('persists the Cursor identity and native default without substituting Claude', () => {
    const row = sessionCreateToRow('cursor-session', { agentKind: 'cursor', model: 'cursor-default',
      permissionMode: 'ask', workingDir: '/repo', providerId: 'cursor' }, 1700000000000);
    expect(row).toMatchObject({ agentKind: 'cursor', model: 'cursor-default', permissionMode: 'ask', providerId: 'cursor' });
  });
});
