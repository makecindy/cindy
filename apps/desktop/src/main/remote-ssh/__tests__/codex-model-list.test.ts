import { describe, expect, it, vi } from 'vitest';
import type { CodexModelListItem } from '@cindy/maker-core';
vi.mock('electron', () => ({ app: {} }));
import { remoteCodexProvider } from '../../maker-host/ssh-codex-models.js';
import { readSshCodexModelList, assertSshCodexModel, isVerifiedSshCodexResume } from '../codex-model-list.js';
import { createIpcError } from '../../../shared/ipc-errors.js';

describe('SSH Codex model projection and admission', () => {
  it('allows the persisted remote route to resume without requiring current catalog membership', () => {
    const request = { model: 'hidden-old-model', providerId: 'openai', remoteHostId: 'builder', resumeSessionId: 'thread' };
    const stored = { ...request, sdkSessionId: 'thread', agentKind: 'codex' };
    expect(isVerifiedSshCodexResume(request, stored)).toBe(true);
    expect(isVerifiedSshCodexResume({ ...request, resumeSessionId: undefined }, stored)).toBe(false);
    expect(isVerifiedSshCodexResume(request, undefined)).toBe(false);
    for (const patch of [{ model: 'changed' }, { providerId: 'xd' }, { remoteHostId: 'another' }, { resumeSessionId: 'another' }]) {
      expect(isVerifiedSshCodexResume({ ...request, ...patch }, stored)).toBe(false);
    }
    expect(isVerifiedSshCodexResume(request, { ...stored, agentKind: 'claude-code' })).toBe(false);
  });
  const native = (model: string, patch: Partial<CodexModelListItem> = {}) => ({
    id: model, model, displayName: model, description: '', hidden: false, isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }],
    defaultReasoningEffort: 'low', additionalSpeedTiers: [], serviceTiers: [], ...patch,
  }) as CodexModelListItem;
  it('uses remote membership, default model, effort and Fast without controller discovery', () => {
    const provider = remoteCodexProvider([native('other'), native('hidden', { hidden: true }),
      native('remote-default', { isDefault: true, additionalSpeedTiers: ['fast'] })]);
    expect(provider.models.codex?.map((model) => model.id)).toEqual(['remote-default', 'other']);
    expect(provider.models.codex?.[0]).toMatchObject({ efforts: ['low'], defaultEffort: 'low', supportsFastMode: true });
    expect(provider.connected).toBe(true);
    expect(provider.models.codex?.[0].contextWindowVerified).not.toBe(true);
    expect(assertSshCodexModel([provider], 'remote-default', 'openai').id).toBe('remote-default');
    expect(() => assertSshCodexModel([provider], 'local-only', 'openai')).toThrow('[INVALID_PARAMS]');
    expect(() => assertSshCodexModel([provider], 'remote-default', 'xd')).toThrow('[REMOTE_CODEX_SOURCE_UNSUPPORTED]');
  });
  it('validates input before reading', async () => {
    const read = vi.fn();
    await expect(readSshCodexModelList({ id: 123 }, read)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(readSshCodexModelList({ id: 'x'.repeat(257) }, read)).rejects.toThrow('[INVALID_PARAMS]');
    expect(read).not.toHaveBeenCalled();
  });
  // The renderer explains each category differently, so a reconnect prompt must not hide
  // an install or runtime failure (#11445). Remote text may hold credentials and never passes.
  it.each([
    ['an unconnected host', createIpcError('SSH_NOT_CONNECTED', 'ssh host builder not connected test-secret'), 'SSH_NOT_CONNECTED'],
    ['a removed host', createIpcError('SSH_HOST_NOT_FOUND', 'unknown ssh host: test-secret'), 'SSH_NOT_CONNECTED'],
    ['a failed install', createIpcError('SSH_INSTALL_FAILED', 'curl: (56) test-secret'), 'SSH_INSTALL_FAILED'],
    ['an unexpected install error', createIpcError('INTERNAL', 'test-secret'), 'SSH_EXEC_FAILED'],
    ['an app-server RPC failure', new Error('File exists (os error 17) test-secret'), 'SSH_EXEC_FAILED'],
  ])('reports %s by category without the remote message', async (_case, failure, code) => {
    const error = await readSshCodexModelList({ id: 'builder' }, vi.fn().mockRejectedValue(failure)).catch((err: unknown) => err);
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain('test-secret');
  });
  it('treats an empty remote snapshot as a retryable failure rather than a local connection prompt', async () => {
    await expect(readSshCodexModelList({ id: 'builder' }, async () => [remoteCodexProvider([])]))
      .rejects.toMatchObject({ code: 'SSH_CODEX_MODELS_EMPTY' });
  });
});
