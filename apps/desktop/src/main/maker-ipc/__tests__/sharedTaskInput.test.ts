import { describe, expect, it } from 'vitest';
import { stampSharedTaskInput, assertSharedTaskQueueMutation } from '../sharedTaskInput.js';
import type { SharedTaskPeerCapture } from '../../device-link/sharedTaskDispatch.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

const author = { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'guest-id', accountId: 'guest', displayName: 'Guest' };
const capture: SharedTaskPeerCapture = { author, isCurrent: () => true, authorize: () => true };
const item = { clientId: 'message', text: 'hello', persistedContent: 'hello',
  permissionMode: 'bypassPermissions', workingDir: 'untrusted', model: 'untrusted', effort: 'untrusted',
  createOpts: { agentKind: 'pi', workingDir: 'untrusted', permissionMode: 'bypassPermissions', model: 'untrusted', vendorOptions: { extraDirs: ['private'] } },
  vendorOptions: { extraDirs: ['private'] }, userName: 'Owner',
  chatMessage: { clientId: 'message', role: 'user', content: 'hello' },
} satisfies AgentInputQueuedMessage;

describe('sharedTask input uses the task Agent authority', () => {
  it.each(['ask', 'bypassPermissions'])('keeps the host permission mode %s, without a guest policy', (permissionMode) => {
    const task = { agentKind: 'pi' as const, workingDir: 'host-workdir', model: 'host-model', permissionMode };
    const result = stampSharedTaskInput(item, capture, task);
    expect(result.createOpts).toEqual(task);
    expect(result.permissionMode).toBe(permissionMode);
    expect(result.workingDir).toBe('host-workdir');
    expect(result).not.toHaveProperty('vendorOptions');
    expect(result).not.toHaveProperty('turnPermissionPolicy');
    expect(result.sharedTaskAuthor).toEqual(author);
    expect(result.userName).toBe('Guest');
  });
  it('strips a forged author from ordinary local input and rejects revoked preparation', () => {
    expect(stampSharedTaskInput({ ...item, sharedTaskAuthor: author }, undefined, undefined)).not.toHaveProperty('sharedTaskAuthor');
    expect(() => stampSharedTaskInput(item, { ...capture, isCurrent: () => false }, item.createOpts)).toThrow();
  });
  it('allows editing only the original membership own pending message, rechecking revocation', () => {
    const owned = { ...item, sharedTaskAuthor: author };
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.edit', owned)).not.toThrow();
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.withdraw', item)).toThrow();
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.edit', { ...owned, sharedTaskAuthor: { ...author, memberId: 'retired-member' } })).toThrow();
    expect(() => assertSharedTaskQueueMutation({ ...capture, isCurrent: () => false }, 'task', 'input.edit', owned)).toThrow();
    expect(() => assertSharedTaskQueueMutation(undefined, 'task', 'input.edit', owned)).not.toThrow();
  });
});
