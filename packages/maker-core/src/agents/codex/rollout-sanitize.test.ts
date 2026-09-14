import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
  sanitizeCodexForkRolloutFileInPlace,
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

  it('atomically sanitizes an unloaded child rollout in place', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-test-'));
    const rollout = path.join(dir, 'rollout-child.jsonl');
    await fs.writeFile(
      rollout,
      [
        JSON.stringify({ payload: { type: 'message', role: 'user', content: 'hello' } }),
        JSON.stringify({ payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
        JSON.stringify({ payload: { type: 'message', role: 'assistant', content: 'world' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    try {
      const stats = await sanitizeCodexForkRolloutFileInPlace(rollout);
      const out = await fs.readFile(rollout, 'utf8');
      expect(out).toContain('hello');
      expect(out).toContain('world');
      expect(out).not.toContain('encrypted_content');
      expect(stats.unsafeLines).toBe(1);
      expect((await fs.readdir(dir)).filter((name) => name.includes('.cindy-sanitize-'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('routes lazy indexed history to recovery without rewriting source or child', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-history-'));
    const source = path.join(dir, 'rollout-source-thread.jsonl');
    const child = path.join(dir, 'rollout-child-thread.jsonl');
    const sourceText = [
      JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: 'source-thread', session_id: 'source-thread' } }),
      JSON.stringify({ ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }),
      JSON.stringify({ ordinal: 2, type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
      JSON.stringify({ ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'world' } }),
    ].join('\n') + '\n';
    const childText = [
      JSON.stringify({
        ordinal: 4,
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          session_id: 'child-thread',
          model_provider: 'target-provider',
          history_base: {
            thread_id: 'source-thread',
            end_ordinal_exclusive: 4,
            end_byte_offset: Buffer.byteLength(sourceText),
          },
        },
      }),
      JSON.stringify({ ordinal: 5, type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
    ].join('\n') + '\n';
    await fs.writeFile(source, sourceText, 'utf8');
    await fs.writeFile(child, childText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(child)).rejects.toMatchObject({
        code: 'CODEX_HISTORY_RECOVERY_REQUIRED',
      });
      expect(await fs.readFile(child, 'utf8')).toBe(childText);
      expect(await fs.readFile(source, 'utf8')).toBe(sourceText);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed instead of rewriting an unsafe lazy child tail', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-history-tail-'));
    const child = path.join(dir, 'rollout-child.jsonl');
    const childText = [
      JSON.stringify({
        ordinal: 4,
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          history_base: {
            thread_id: 'source-thread',
            end_ordinal_exclusive: 4,
            end_byte_offset: 1,
          },
        },
      }),
      JSON.stringify({ ordinal: 5, type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
    ].join('\n') + '\n';
    await fs.writeFile(child, childText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(child)).rejects.toMatchObject({ code: 'CODEX_HISTORY_RECOVERY_REQUIRED' });
      expect(await fs.readFile(child, 'utf8')).toBe(childText);
      expect((await fs.readdir(dir)).some((name) => name.includes('.cindy-sanitize-'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('protects materialized indexed history too, including its native offsets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-fork-meta-'));
    const child = path.join(dir, 'rollout-child.jsonl');
    const childText = [
      JSON.stringify({
        ordinal: 0,
        type: 'session_meta',
        payload: {
          id: 'child',
          forked_from_id: 'source',
          forked_from_ordinal_exclusive: 3,
        },
      }),
      JSON.stringify({ ordinal: 1, type: 'response_item', payload: { type: 'message', content: 'one' } }),
      JSON.stringify({ ordinal: 2, type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret' } }),
      JSON.stringify({ ordinal: 3, type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n') + '\n';
    await fs.writeFile(child, childText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(child)).rejects.toMatchObject({
        code: 'CODEX_HISTORY_RECOVERY_REQUIRED',
      });
      expect(await fs.readFile(child, 'utf8')).toBe(childText);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('requests a handoff for corrupt JSON without modifying the source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-corrupt-'));
    const source = path.join(dir, 'source.jsonl');
    const original = '{"type":"session_meta","payload":{"id":"source"}}\n{"unfinished":';
    try {
      await fs.writeFile(source, original);
      await expect(sanitizeCodexForkRolloutFileInPlace(source)).rejects.toMatchObject({ code: 'CODEX_HISTORY_RECOVERY_REQUIRED' });
      expect(await fs.readFile(source, 'utf8')).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed lazy history_base metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-history-invalid-'));
    const child = path.join(dir, 'rollout-child.jsonl');
    const childText = `${JSON.stringify({
      ordinal: 1,
      type: 'session_meta',
      payload: { id: 'child', history_base: { thread_id: 'source', end_byte_offset: 1 } },
    })}\n`;
    await fs.writeFile(child, childText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(child)).rejects.toMatchObject({ code: 'CODEX_HISTORY_RECOVERY_REQUIRED' });
      expect(await fs.readFile(child, 'utf8')).toBe(childText);
      expect((await fs.readdir(dir)).some((name) => name.includes('.cindy-sanitize-'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a lazy history_base offset that is outside the source rollout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-history-offset-'));
    const source = path.join(dir, 'rollout-source.jsonl');
    const child = path.join(dir, 'rollout-child.jsonl');
    const sourceText = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'source' },
    })}\n`;
    const childText = `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child',
        history_base: {
          thread_id: 'source',
          end_ordinal_exclusive: 1,
          end_byte_offset: Buffer.byteLength(sourceText) + 1,
        },
      },
    })}\n`;
    await fs.writeFile(source, sourceText, 'utf8');
    await fs.writeFile(child, childText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(child)).rejects.toMatchObject({ code: 'CODEX_HISTORY_RECOVERY_REQUIRED' });
      expect(await fs.readFile(child, 'utf8')).toBe(childText);
      expect(await fs.readFile(source, 'utf8')).toBe(sourceText);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cyclic lazy history_base chain without changing either rollout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-history-cycle-'));
    const first = path.join(dir, 'rollout-first.jsonl');
    const second = path.join(dir, 'rollout-second.jsonl');
    const make = (id: string, threadId: string, endByteOffset: number) => `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id,
        history_base: {
          thread_id: threadId,
          end_ordinal_exclusive: 1,
          end_byte_offset: endByteOffset,
        },
      },
    })}\n`;
    let firstText = '';
    let secondText = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      firstText = make('first', 'second', Buffer.byteLength(secondText) || 1);
      secondText = make('second', 'first', Buffer.byteLength(firstText));
    }
    await fs.writeFile(first, firstText, 'utf8');
    await fs.writeFile(second, secondText, 'utf8');
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(first)).rejects.toMatchObject({ code: 'CODEX_HISTORY_RECOVERY_REQUIRED' });
      expect(await fs.readFile(first, 'utf8')).toBe(firstText);
      expect(await fs.readFile(second, 'utf8')).toBe(secondText);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('retries transient Windows replacement errors and then succeeds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-retry-'));
    const rollout = path.join(dir, 'rollout-child.jsonl');
    const text = `${JSON.stringify({ payload: { type: 'message', content: 'safe' } })}\n`;
    await fs.writeFile(rollout, text, 'utf8');
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockImplementation((from, to) => realRename(from, to));
    try {
      await sanitizeCodexForkRolloutFileInPlace(rollout, {
        replaceMaxAttempts: 3,
        replaceRetryMs: 0,
      });
      expect(rename).toHaveBeenCalledTimes(3);
      expect(await fs.readFile(rollout, 'utf8')).toBe(text);
    } finally {
      rename.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not retry non-transient replacement errors and preserves the canonical child', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-no-retry-'));
    const rollout = path.join(dir, 'rollout-child.jsonl');
    const text = `${JSON.stringify({ payload: { type: 'message', content: 'safe' } })}\n`;
    await fs.writeFile(rollout, text, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('invalid'), { code: 'EINVAL' }),
    );
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(rollout, {
        replaceMaxAttempts: 3,
        replaceRetryMs: 0,
      })).rejects.toMatchObject({ code: 'EINVAL' });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(rollout, 'utf8')).toBe(text);
      expect((await fs.readdir(dir)).some((name) => name.includes('.cindy-sanitize-'))).toBe(false);
    } finally {
      rename.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stops after the bounded Windows replacement retry budget', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-rollout-retry-exhausted-'));
    const rollout = path.join(dir, 'rollout-child.jsonl');
    const text = `${JSON.stringify({ payload: { type: 'message', content: 'safe' } })}\n`;
    await fs.writeFile(rollout, text, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'EACCES' }),
    );
    try {
      await expect(sanitizeCodexForkRolloutFileInPlace(rollout, {
        replaceMaxAttempts: 3,
        replaceRetryMs: 0,
      })).rejects.toMatchObject({ code: 'EACCES' });
      expect(rename).toHaveBeenCalledTimes(3);
      expect(await fs.readFile(rollout, 'utf8')).toBe(text);
      expect((await fs.readdir(dir)).some((name) => name.includes('.cindy-sanitize-'))).toBe(false);
    } finally {
      rename.mockRestore();
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
