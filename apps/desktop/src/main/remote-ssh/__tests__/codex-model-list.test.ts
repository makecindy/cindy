import { describe, expect, it, vi } from 'vitest';
import type { CodexModelListItem } from '@cindy/maker-core';
vi.mock('electron', () => ({ app: {} }));
import { remoteCodexProvider } from '../../maker-host/ssh-codex-models.js';
import { readSshCodexModelList, assertSshCodexModel, isVerifiedSshCodexResume } from '../codex-model-list.js';

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
    expect(() => assertSshCodexModel([provider], 'remote-default', 'xd')).toThrow('[INVALID_PARAMS]');
  });
  it('validates input before reading and never exposes an RPC secret in an error', async () => {
    const read = vi.fn().mockRejectedValue(new Error('test-secret-not-for-renderer'));
    await expect(readSshCodexModelList({ id: 123 }, read)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(readSshCodexModelList({ id: 'x'.repeat(257) }, read)).rejects.toThrow('[INVALID_PARAMS]');
    expect(read).not.toHaveBeenCalled();
    await expect(readSshCodexModelList({ id: 'builder' }, read)).rejects.toThrow('[SSH_EXEC_FAILED] Unable to read remote Codex models; reconnect and retry');
  });
  it('treats an empty remote snapshot as a retryable failure rather than a local connection prompt', async () => {
    await expect(readSshCodexModelList({ id: 'builder' }, async () => [remoteCodexProvider([])]))
      .rejects.toThrow('[SSH_EXEC_FAILED]');
  });
});
