import { expect, it } from 'vitest';
import { companionWorkingPhase } from '../session/companionWorkingPhase';
import type { RemoteMessage } from '../session/types';
const row = (role: RemoteMessage['role'], content: unknown = '', extra = {}) => ({ id: 'row', clientId: 'row', sessionId: 's', role, content, toolUseId: null, agentMeta: null, createdAt: '', ...extra });
it('keeps the current user turn separate from the previous tool feedback', () => {
  expect(companionWorkingPhase([row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'read', path: 'private' } }), row('user', 'new', { id: 'new' })])).toEqual({ phase: 'thinking', turnId: 'new' });
});
it('tracks public tool subjects and never claims a returned tool is still running', () => {
  const input = [row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'write', body: 'private' } }, { toolUseId: 't' })];
  expect(companionWorkingPhase(input).phase).toBe('saving-memory');
  expect(companionWorkingPhase([...input, row('tool_result', 'failure', { toolUseId: 't' })]).phase).toBe('reviewing-memory');
  expect(companionWorkingPhase([...input, row('tool_result', 'foreign result', { toolUseId: 'other' })]).phase).toBe('saving-memory');
});
it('hands the reply position to actual content or an interaction card', () => {
  for (const final of [row('assistant', { text: 'Hello' }), row('assistant', 'Hello'), row('ask_user'), row('plan_review'), row('error')]) {
    expect(companionWorkingPhase([row('user'), final]).phase).toBeNull();
  }
});
it('does not use background activity as the foreground turn', () => {
  expect(companionWorkingPhase([row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'delete' } }, { agentMeta: { turnScope: 'background' } })]).phase).toBe('thinking');
});
