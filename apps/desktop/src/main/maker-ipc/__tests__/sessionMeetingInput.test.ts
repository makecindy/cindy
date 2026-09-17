import { describe, expect, it } from 'vitest';
import { stampSessionMeetingInput, assertSessionMeetingQueueMutation } from '../sessionMeetingInput.js';
import type { SessionMeetingPeerCapture } from '../../device-link/sessionMeetingDispatch.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

const author = { meetingId: 'meeting', sessionId: 'task', memberId: 'guest-id', accountId: 'guest', displayName: 'Guest' };
const capture: SessionMeetingPeerCapture = { author, isCurrent: () => true, authorize: () => true };
const item = { clientId: 'message', text: 'hello', persistedContent: 'hello',
  permissionMode: 'bypassPermissions', workingDir: 'untrusted', model: 'untrusted', effort: 'untrusted',
  createOpts: { agentKind: 'pi', workingDir: 'untrusted', permissionMode: 'bypassPermissions', model: 'untrusted', vendorOptions: { extraDirs: ['private'] } },
  vendorOptions: { extraDirs: ['private'] }, userName: 'Owner',
  chatMessage: { clientId: 'message', role: 'user', content: 'hello' },
} satisfies AgentInputQueuedMessage;

describe('meeting input uses the task Agent authority', () => {
  it.each(['ask', 'bypassPermissions'])('keeps the host permission mode %s, without a guest policy', (permissionMode) => {
    const task = { agentKind: 'pi' as const, workingDir: 'host-workdir', model: 'host-model', permissionMode };
    const result = stampSessionMeetingInput(item, capture, task);
    expect(result.createOpts).toEqual(task);
    expect(result.permissionMode).toBe(permissionMode);
    expect(result.workingDir).toBe('host-workdir');
    expect(result).not.toHaveProperty('vendorOptions');
    expect(result).not.toHaveProperty('turnPermissionPolicy');
    expect(result.meetingAuthor).toEqual(author);
    expect(result.userName).toBe('Guest');
  });
  it('strips a forged author from ordinary local input and rejects revoked preparation', () => {
    expect(stampSessionMeetingInput({ ...item, meetingAuthor: author }, undefined, undefined)).not.toHaveProperty('meetingAuthor');
    expect(() => stampSessionMeetingInput(item, { ...capture, isCurrent: () => false }, item.createOpts)).toThrow();
  });
  it('allows editing only the original membership own pending message, rechecking revocation', () => {
    const owned = { ...item, meetingAuthor: author };
    expect(() => assertSessionMeetingQueueMutation(capture, 'task', 'input.edit', owned)).not.toThrow();
    expect(() => assertSessionMeetingQueueMutation(capture, 'task', 'input.withdraw', item)).toThrow();
    expect(() => assertSessionMeetingQueueMutation(capture, 'task', 'input.edit', { ...owned, meetingAuthor: { ...author, memberId: 'retired-member' } })).toThrow();
    expect(() => assertSessionMeetingQueueMutation({ ...capture, isCurrent: () => false }, 'task', 'input.edit', owned)).toThrow();
    expect(() => assertSessionMeetingQueueMutation(undefined, 'task', 'input.edit', owned)).not.toThrow();
  });
});
