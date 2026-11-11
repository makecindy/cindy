/**
 * createMemoryReviewOneShot — memory_review 的共享辅助模型链接入口回归。
 *
 * 契约: maker 未就绪 / 链失败 / 链产出为空 → 一律返回 null(不抛), 由
 * MakerMemoryManager 回退 review agent 默认路由; 链有产出 → 原文返回。
 */

import type { Maker } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import { createMemoryReviewOneShot } from '../memory-review-one-shot.js';

vi.mock('../index.js', () => ({ getMakerIfReady: () => ({}) }));

function ok(text: string): UtilityTextResult {
  return { ok: true, text, providerId: 'p', model: 'm', transport: 'litellm-chat-completions' };
}

function failed(): UtilityTextResult {
  return { ok: false, reason: 'all_candidates_failed', attempts: [] };
}

const maker = {} as Maker;

describe('createMemoryReviewOneShot', () => {
  it('returns the chain text when the utility chain produces it', async () => {
    const requestText = vi.fn(async () => ok('merge a into b'));
    const oneShot = createMemoryReviewOneShot({ getMaker: () => maker, requestText });
    await expect(oneShot('prompt', { maxTokens: 800, timeoutMs: 60_000 })).resolves.toBe(
      'merge a into b',
    );
    expect(requestText).toHaveBeenCalledWith(maker, 'prompt', {
      maxTokens: 800,
      timeoutMs: 60_000,
      disableReasoning: true,
    });
  });

  it('returns null when maker is not ready, without dispatching', async () => {
    const requestText = vi.fn(async () => ok('x'));
    const oneShot = createMemoryReviewOneShot({ getMaker: () => null, requestText });
    await expect(oneShot('prompt', { maxTokens: 800, timeoutMs: 60_000 })).resolves.toBeNull();
    expect(requestText).not.toHaveBeenCalled();
  });

  it('returns null when the chain text is only whitespace', async () => {
    const oneShot = createMemoryReviewOneShot({
      getMaker: () => maker,
      requestText: async () => ok('   \n '),
    });
    await expect(oneShot('prompt', { maxTokens: 800, timeoutMs: 60_000 })).resolves.toBeNull();
  });

  it('returns null when the chain reports no usable candidate', async () => {
    const oneShot = createMemoryReviewOneShot({
      getMaker: () => maker,
      requestText: async () => failed(),
    });
    await expect(oneShot('prompt', { maxTokens: 800, timeoutMs: 60_000 })).resolves.toBeNull();
  });

  it('returns null instead of throwing when the chain request throws', async () => {
    const oneShot = createMemoryReviewOneShot({
      getMaker: () => maker,
      requestText: async () => {
        throw new Error('boom');
      },
    });
    await expect(oneShot('prompt', { maxTokens: 800, timeoutMs: 60_000 })).resolves.toBeNull();
  });
});
