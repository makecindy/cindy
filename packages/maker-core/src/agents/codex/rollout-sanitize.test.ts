import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CODEX_INLINE_IMAGE_STRIP_MIN_CHARS,
  CODEX_LIVE_TAIL_OVERSIZED_BYTES,
  CodexRolloutScanLimitError,
  hasUnsafeForkRolloutPayload,
  isOversizedLiveTailStats,
  measureRolloutLiveTailBytesFromText,
  measureRolloutLiveTailStats,
  measureRolloutLiveTailStatsFromText,
  rewriteOversizedToolOutputImages,
  sanitizeCodexForkRollout,
  sanitizeCodexForkRolloutFile,
} from './rollout-sanitize.js';

function bigPngDataUri(chars = CODEX_INLINE_IMAGE_STRIP_MIN_CHARS): string {
  return `data:image/png;base64,${'A'.repeat(chars)}`;
}

function compactBoundary(): string {
  return JSON.stringify({ type: 'compacted', payload: { replacement_history: [] } });
}

describe('hasUnsafeForkRolloutPayload', () => {
  it('drops reasoning and image generation without id', () => {
    expect(
      hasUnsafeForkRolloutPayload(JSON.stringify({ payload: { type: 'reasoning', encrypted_content: 'gAAA' } })),
    ).toBe(true);
    expect(
      hasUnsafeForkRolloutPayload(
        JSON.stringify({ payload: { type: 'image_generation_end', call_id: 'ig_1' } }),
      ),
    ).toBe(true);
    expect(
      hasUnsafeForkRolloutPayload(
        JSON.stringify({ payload: { type: 'image_generation_call', id: 'ig_1' } }),
      ),
    ).toBe(false);
  });
});

describe('rewriteOversizedToolOutputImages', () => {
  it.each([
    'custom_tool_call_output',
    'function_call_output',
    'customToolCallOutput',
    'functionCallOutput',
  ])('replaces oversized data URIs in %s without deleting the line', (type) => {
    const line = JSON.stringify({ payload: { type, call_id: 'c1', output: bigPngDataUri() } });
    const out = rewriteOversizedToolOutputImages(line);
    expect(out).toContain(`"${type}"`);
    expect(out).toContain('"c1"');
    expect(out).not.toContain(';base64,');
    expect(out).toContain('cindy-omitted-inline-image');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('leaves small images and non-tool payloads alone', () => {
    const small = JSON.stringify({
      payload: { type: 'custom_tool_call_output', output: 'data:image/png;base64,abc' },
    });
    expect(rewriteOversizedToolOutputImages(small)).toBe(small);
    const generation = JSON.stringify({
      payload: { type: 'image_generation_call', id: 'ig_1', result: bigPngDataUri() },
    });
    expect(rewriteOversizedToolOutputImages(generation)).toBe(generation);
  });

  it('turns oversized input_image blocks into input_text instead of invalid image_url', () => {
    const first = bigPngDataUri(620406);
    const second = bigPngDataUri(1366914);
    const line = JSON.stringify({
      timestamp: '2026-08-27T10:00:33.906Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'shot',
        output: [
          { type: 'input_text', text: 'Script completed\n' },
          { type: 'input_image', image_url: first, detail: 'high' },
          { type: 'input_image', image_url: { url: second }, detail: 'high' },
        ],
      },
    });
    const out = JSON.parse(rewriteOversizedToolOutputImages(line));
    expect(out.payload.call_id).toBe('shot');
    expect(out.payload.output).toEqual([
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: `[cindy-omitted-inline-image chars=${first.length}]` },
      { type: 'input_text', text: `[cindy-omitted-inline-image chars=${second.length}]` },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/"image_url":"\[cindy-omitted/);
    expect(JSON.stringify(out)).not.toContain(';base64,');
  });

  it('does not swallow trailing tool text after a data URI', () => {
    const uri = bigPngDataUri();
    const line = JSON.stringify({
      payload: {
        type: 'function_call_output',
        call_id: 'c1',
        output: `${uri} image generated successfully`,
      },
    });
    const out = JSON.parse(rewriteOversizedToolOutputImages(line));
    expect(out.payload.output).toBe(
      `[cindy-omitted-inline-image chars=${uri.length}] image generated successfully`,
    );
  });

  it('keeps sibling metadata when an oversized image_url is not an input_image block', () => {
    const uri = bigPngDataUri();
    const line = JSON.stringify({
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'shot',
        output: {
          type: 'tool_meta',
          caption: 'login screen',
          image_url: uri,
        },
      },
    });
    const out = JSON.parse(rewriteOversizedToolOutputImages(line));
    expect(out.payload.output).toEqual({ type: 'tool_meta', caption: 'login screen' });
    expect(JSON.stringify(out)).not.toContain(';base64,');
    expect(JSON.stringify(out)).not.toMatch(/"image_url":"\[cindy-omitted/);
  });
});

describe('sanitizeCodexForkRollout', () => {
  it('drops unsafe lines and rewrites oversized tool images', () => {
    const text = [
      JSON.stringify({ payload: { type: 'message', role: 'user' } }),
      JSON.stringify({ payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'shot', output: bigPngDataUri() } }),
      JSON.stringify({ payload: { type: 'message', role: 'assistant' } }),
    ].join('\n');
    const out = sanitizeCodexForkRollout(text);
    expect(out).toContain('"user"');
    expect(out).toContain('"assistant"');
    expect(out).toContain('"shot"');
    expect(out).not.toContain('encrypted_content');
    expect(out).not.toContain(';base64,');
  });

  it('streams a sanitized copy and reports byte reductions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-test-'));
    const source = path.join(dir, 'source.jsonl');
    const target = path.join(dir, 'target.jsonl');
    const call = JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'shot' } });
    const result = JSON.stringify({
      payload: { type: 'custom_tool_call_output', call_id: 'shot', output: bigPngDataUri() },
    });
    await fs.writeFile(source, [call, result].join('\n'), 'utf8');
    try {
      const stats = await sanitizeCodexForkRolloutFile(source, target);
      const out = await fs.readFile(target, 'utf8');
      const lines = out.trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0].payload.call_id).toBe('shot');
      expect(lines[1].payload.call_id).toBe('shot');
      expect(out).not.toContain(';base64,');
      expect(stats.rewrittenLines).toBe(1);
      expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
      expect(stats.strippedBytes).toBeGreaterThan(CODEX_INLINE_IMAGE_STRIP_MIN_CHARS - 64);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('live-tail classification', () => {
  it('counts bytes after the last real rollout compaction boundary', () => {
    const tail = JSON.stringify({ payload: { type: 'custom_tool_call_output', output: 'x'.repeat(100) } });
    const text = [
      JSON.stringify({ payload: { type: 'message', role: 'user' } }),
      compactBoundary(),
      JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
      tail,
    ].join('\n');
    expect(measureRolloutLiveTailBytesFromText(text)).toBe(Buffer.byteLength(tail, 'utf8') + 1);
  });

  it('classifies image-heavy live tails as recoverable by strip-fork', () => {
    const imageChars = CODEX_LIVE_TAIL_OVERSIZED_BYTES + CODEX_INLINE_IMAGE_STRIP_MIN_CHARS;
    const text = [
      compactBoundary(),
      JSON.stringify({
        payload: { type: 'custom_tool_call_output', call_id: 'shot', output: bigPngDataUri(imageChars) },
      }),
    ].join('\n');
    const stats = measureRolloutLiveTailStatsFromText(text);
    expect(stats.rewrittenLines).toBe(1);
    expect(stats.projectedTailBytes).toBeLessThan(CODEX_LIVE_TAIL_OVERSIZED_BYTES);
    expect(isOversizedLiveTailStats(stats)).toBe(true);
  });

  it('does not classify large pure-text history as an image problem', () => {
    const text = [
      compactBoundary(),
      JSON.stringify({ payload: { type: 'message', role: 'user', content: 'x'.repeat(CODEX_LIVE_TAIL_OVERSIZED_BYTES + 1) } }),
    ].join('\n');
    const stats = measureRolloutLiveTailStatsFromText(text);
    expect(stats.tailBytes).toBeGreaterThan(CODEX_LIVE_TAIL_OVERSIZED_BYTES);
    expect(stats.strippedBytes).toBe(0);
    expect(isOversizedLiveTailStats(stats)).toBe(false);
  });

  it('does not treat reasoning-heavy tails as an image problem', () => {
    const blob = 'g'.repeat(CODEX_LIVE_TAIL_OVERSIZED_BYTES + 1);
    const text = [
      compactBoundary(),
      JSON.stringify({ payload: { type: 'reasoning', encrypted_content: blob } }),
    ].join('\n');
    const stats = measureRolloutLiveTailStatsFromText(text);
    expect(stats.tailBytes).toBeGreaterThan(CODEX_LIVE_TAIL_OVERSIZED_BYTES);
    expect(stats.unsafeLines).toBe(1);
    expect(stats.rewrittenLines).toBe(0);
    expect(stats.strippedBytes).toBe(0);
    expect(isOversizedLiveTailStats(stats)).toBe(false);
  });

  it('stops before a single JSONL line exceeds the byte cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-line-cap-'));
    const source = path.join(dir, 'source.jsonl');
    await fs.writeFile(source, `${'A'.repeat(200)}\n`, 'utf8');
    try {
      await expect(
        measureRolloutLiveTailStats(source, { maxLineBytes: 50 }),
      ).rejects.toBeInstanceOf(CodexRolloutScanLimitError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
