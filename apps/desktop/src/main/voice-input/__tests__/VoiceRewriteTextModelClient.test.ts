/**
 * Unit tests for VoiceRewriteTextModelClient (auxiliary model routing for voice rewrite).
 * Verifies:
 * - Routes via requestUtilityText with `source: 'voice-rewrite'` (never voice-server `/refine`)
 * - Parses strict and fenced JSON `{"text": "..."}` responses
 * - Enforces owner-fence guard before & after dispatch
 * - Never leaks raw model output into thrown error messages
 *
 * Tier: unit (< 50ms).
 */
import { describe, expect, it, vi } from 'vitest';

import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import type { UtilityTextRequestOptions } from '../../utility-model/oneShotCandidates.js';
import { VoiceRewriteTextModelClient, parseRewriteResponse } from '../VoiceRewriteTextModelClient.js';

describe('VoiceRewriteTextModelClient', () => {
  it('routes rewrite requests through requestUtilityText and captures served route', async () => {
    const requestText = vi.fn(async (_prompt: string, opts: UtilityTextRequestOptions): Promise<UtilityTextResult> => {
      expect(opts.source).toBe('voice-rewrite');
      expect(opts.disableReasoning).toBe(true);
      await opts.beforeDispatch?.({
        providerId: 'anthropic',
        agentKind: 'claude-code',
        model: 'claude-haiku',
      });
      expect(opts.validateResponse?.('{"text":"Rewritten text"}')).toBe(true);
      expect(opts.validateResponse?.('not json')).toBe(false);
      return {
        ok: true,
        text: '```json\n{"text":"Rewritten text"}\n```',
        providerId: 'anthropic',
        model: 'claude-haiku',
        transport: 'litellm-chat-completions',
      };
    });
    const assertCurrent = vi.fn();

    const client = new VoiceRewriteTextModelClient(requestText, assertCurrent);
    const parsed = await client.requestJson<{ text: string }>({
      model: 'auxiliary',
      system: 'rewrite system prompt',
      user: { selectedText: 'hello', instruction: 'make formal' },
      schemaName: 'dictation_rewrite',
    });

    expect(parsed).toEqual({ text: 'Rewritten text' });
    expect(client.servedRoute).toEqual({ providerId: 'anthropic', model: 'claude-haiku' });
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('rejects with sanitized error when utility model fails or returns invalid JSON', async () => {
    const client = new VoiceRewriteTextModelClient(
      vi.fn(async (): Promise<UtilityTextResult> => ({ ok: false, reason: 'no_candidate', attempts: [] })),
      () => undefined,
    );
    await expect(
      client.requestJson({
        model: 'auxiliary',
        system: 'sys',
        user: {},
        schemaName: 'dictation_rewrite',
      }),
    ).rejects.toThrow('Voice rewrite failed: no_candidate');

    expect(() => parseRewriteResponse('SECRET_MODEL_LEAK_XYZ')).toThrow('Invalid voice rewrite response');
  });
});
