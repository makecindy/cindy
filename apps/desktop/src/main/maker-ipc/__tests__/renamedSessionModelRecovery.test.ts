import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { recoverRenamedSessionModelBeforeSend } from '../renamedSessionModelRecovery';

const route = {
  status: 'active',
  model: 'gpt-6-luna',
  providerId: 'openai',
  agentKind: 'codex' as const,
  effort: 'high',
  fastMode: false,
  remoteHostId: null,
  agentDeviceId: null,
};
const provider = (ids: string[]) => ({
  id: 'openai',
  models: { codex: ids.map(id => ({ id })) },
}) as ProviderView;

describe('recoverRenamedSessionModelBeforeSend', () => {
  it('applies the unique replacement on a direct send with no pending selection', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    const recovered = await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    });
    expect(recovered).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith('chatgpt/gpt-6-luna', 'openai');
  });

  it('does not override a pending choice or guess between two replacements', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: true,
      providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna', 'xai/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves an accepted temporary route or axis override', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: { ...route, model: 'available-fallback' },
      hasPendingSelection: false, providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: { ...route, effort: 'low', fastMode: true },
      hasPendingSelection: false, providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not turn an existing suspended provider into a rejected new route', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    const suspended = { ...provider(['chatgpt/gpt-6-luna']), suspended: true };
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [suspended], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to send when applying the replacement did not finish', async () => {
    await expect(recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna'])],
      apply: async () => ({ deferred: true, superseded: false }),
    })).rejects.toThrow('could not be applied before send');
  });
});
