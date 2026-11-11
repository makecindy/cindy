import { describe, expect, it, vi } from 'vitest';

import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import type { UtilityTextRequestOptions } from '../../utility-model/oneShotCandidates.js';
import { DictionaryLearningTextModelClient } from '../DictionaryLearningTextModelClient.js';

const input = {
  model: 'auxiliary',
  schemaName: 'dictation_dictionary_learning',
  system: 'Existing dictionary learning instructions',
  user: { beforeText: 'web coding', afterText: 'Vibe Coding' },
};
const success: UtilityTextResult = {
  ok: true,
  text: '```json\n{"actions":[]}\n```',
  providerId: 'anthropic',
  model: 'fixture-model',
  transport: 'litellm-chat-completions',
};

describe('DictionaryLearningTextModelClient', () => {
  it('keeps system and evidence separate, accepts wrapped JSON, and leaves routing to the auxiliary chain', async () => {
    const requestText = vi.fn<(prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>>()
      .mockResolvedValue(success);
    const guard = vi.fn();
    const client = new DictionaryLearningTextModelClient(requestText, guard);

    await expect(client.requestJson(input)).resolves.toEqual({ actions: [] });

    const [prompt, opts] = requestText.mock.calls[0];
    expect(JSON.parse(prompt)).toEqual(input.user);
    expect(opts.systemPrompt).toBe(input.system);
    expect(opts.maxTokens).toBe(4_096);
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('model');
    expect(opts).not.toHaveProperty('pinnedProfileId');
    expect(opts.validateResponse?.(success.text)).toBe(true);
    expect(opts.validateResponse?.('{"actions":[]}')).toBe(true);
    for (const text of [
      'private response body', '{"actions":', 'null', '[]',
      '{}', '{"action":"add_entry"}', '{"actions":null}', '{"actions":{}}',
    ]) {
      expect(opts.validateResponse?.(text)).toBe(false);
    }
    expect(client.servedRoute).toEqual({ providerId: 'anthropic', model: 'fixture-model' });
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('checks the original request scope immediately before dispatch', async () => {
    let current = true;
    const guard = () => {
      if (!current) throw new Error('request scope changed');
    };
    const requestText = vi.fn(async (_prompt: string, opts: UtilityTextRequestOptions) => {
      current = false;
      await opts.beforeDispatch?.({ providerId: 'anthropic', agentKind: 'claude-code', model: 'fixture' });
      return success;
    });

    await expect(new DictionaryLearningTextModelClient(requestText, guard).requestJson(input))
      .rejects.toThrow('request scope changed');
  });

  it('rejects a late success after the owner or auxiliary configuration changes', async () => {
    let current = true;
    const requestText = vi.fn(async () => {
      current = false;
      return success;
    });
    const client = new DictionaryLearningTextModelClient(requestText, () => {
      if (!current) throw new Error('request scope changed');
    });

    await expect(client.requestJson(input)).rejects.toThrow('request scope changed');
    expect(client.servedRoute).toBeUndefined();
  });

  it('reports exhausted auxiliary routes without exposing response bodies', async () => {
    const requestText = vi.fn(async (): Promise<UtilityTextResult> => ({
      ok: false, reason: 'all_candidates_failed', attempts: [],
    }));
    const client = new DictionaryLearningTextModelClient(requestText, () => {});

    await expect(client.requestJson(input)).rejects.toThrow('Dictionary learning failed: all_candidates_failed');
    expect(requestText).toHaveBeenCalledTimes(1);
  });

  it('does not return malformed JSON even if a requester ignores the validation hook', async () => {
    const client = new DictionaryLearningTextModelClient(
      async () => ({ ...success, text: 'private response body' }),
      () => {},
    );

    await expect(client.requestJson(input)).rejects.toThrow(/^Invalid dictionary response$/);
    expect(client.servedRoute).toBeUndefined();
  });
});
