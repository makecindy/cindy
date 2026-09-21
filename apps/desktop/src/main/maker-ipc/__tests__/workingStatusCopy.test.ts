import { describe, expect, it, vi } from 'vitest';
import { publicToolPhase, publicToolResultPhase } from '../../../shared/workingStatus.js';
import { WorkingStatusCopy, validateWorkingStatusCopy, workingStatusPrompt } from '../workingStatusCopy.js';

const deferred = () => {
  let resolve!: (text: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('public activity copy', () => {
  it('projects exact memory contracts without forwarding sensitive arguments', () => {
    const phase = publicToolPhase('bot_memory', { action: 'write', body: 'SECRET', filename: '/private/key', token: 'SECRET' });
    expect(phase).toBe('saving-memory');
    const prompt = workingStatusPrompt(phase, 'zh-CN', null);
    expect(prompt).not.toMatch(/SECRET|private|bot_memory/);
    expect(publicToolPhase('mcp__cindy_memory__call_tool', { name: 'memory_read', args: { filename: '/private/key' } })).toBe('reading-memory');
    expect(publicToolPhase('exec', { command: 'memory_write' })).toBe('processing');
    expect(publicToolPhase('untrusted_memory_write', {})).toBe('processing');
  });

  it('coalesces repeated tool calls by semantic phase and reuses finished copy', async () => {
    const generate = vi.fn(async () => '翻翻之前记下的事…');
    const copy = new WorkingStatusCopy(generate);
    const [a, b] = await Promise.all([copy.request('reading-memory'), copy.request('reading-memory')]);
    expect(a).toBe(b);
    expect(generate).toHaveBeenCalledTimes(1);
    copy.observe('thinking');
    expect(await copy.request('reading-memory')).toBe(a);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('aborts and rejects late A after A → B → A, without dispatching every tool', async () => {
    const pending = deferred();
    let signal!: AbortSignal;
    const generate = vi.fn(async (_phase, _previous, s: AbortSignal) => { signal = s; return pending.promise; });
    const copy = new WorkingStatusCopy(generate);
    const first = copy.request('saving-memory');
    await Promise.resolve();
    copy.observe('thinking');
    expect(signal.aborted).toBe(true);
    const again = copy.request('saving-memory');
    pending.resolve('把这件事记下来…');
    expect(await first).toBeNull();
    expect(await again).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('discards late completion, clears turn cache and tolerates timeouts/rejections', async () => {
    const pending = deferred();
    const generate = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('timeout'));
    const copy = new WorkingStatusCopy(generate);
    const first = copy.request('replying');
    await Promise.resolve();
    copy.dispose();
    pending.resolve('把话说清楚…');
    expect(await first).toBeNull();
    expect(await copy.request('replying')).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not start a request invalidated before its dispatch microtask', async () => {
    const generate = vi.fn();
    const copy = new WorkingStatusCopy(generate);
    const pending = copy.request('thinking');
    copy.dispose();
    expect(await pending).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['已保存好了', '记住了', 'Saved the memory', '完成了！', '90% ready', 'Successfully saved', 'mcp__memory__write', '/private/key', 'line\nbreak', '<think>reason</think>'])('rejects unsafe or misleading copy: %s', (raw) => {
    expect(validateWorkingStatusCopy(raw)).toBeNull();
  });
  it('accepts short ongoing captions in the UI languages', () => {
    for (const text of ['把这件事记下来…', '翻翻之前記下的事…', 'Putting the reply into words…', '返事をまとめています…', '답변을 정리하고 있어요…']) {
      expect(validateWorkingStatusCopy(text)).toBe(text);
    }
  });
});

it('uses shared safe command semantics but sends neither command nor target', () => {
  const cases = [
    ['bash', { command: 'curl -s https://example.com/private?token=SECRET' }, 'reading-web'],
    ['bash', { command: 'cat private-key.txt' }, 'reading-file'],
    ['bash', { command: 'rg SECRET src' }, 'searching-files'],
    ['bash', { command: 'pnpm test' }, 'testing'],
    ['bash', { command: 'pnpm typecheck' }, 'checking'],
    ['bash', { command: 'cat private-key.txt > copied.txt' }, 'processing'],
    ['bash', { command: 'curl -X POST https://example.com' }, 'processing'],
    ['bash', { command: 'cat a && rm b' }, 'processing'],
    ['mcp:cindy_memory:call_tool', { name: 'memory_write', args: { body: 'SECRET' } }, 'saving-memory'],
  ] as const;
  for (const [tool, input, expected] of cases) {
    const phase = publicToolPhase(tool, input);
    expect(phase).toBe(expected);
    expect(workingStatusPrompt(phase, 'en', null)).not.toMatch(/SECRET|private-key|example\.com|curl|pnpm/);
  }
});
it('rejects a generic model caption that erases the concrete action', () => {
  expect(validateWorkingStatusCopy('Working through it now.', 'reading-web')).toBeNull();
  expect(validateWorkingStatusCopy('Working through it now.', 'processing')).toBeNull();
  expect(validateWorkingStatusCopy('Reading the web page…', 'reading-web')).toBeTruthy();
});

it.each([
  ['delete', 'deleting-memory', 'Deleting memory…'],
  ['review', 'reviewing-memory', 'Checking memory…'],
  ['consolidate', 'organizing-memory', 'Organizing memory…'],
] as const)('recognizes memory %s across direct and MCP tools without leaking arguments', (action, expected, caption) => {
  const privateArgs = { filename: '/private/SECRET', body: 'SECRET', sources: ['SECRET'] };
  const calls = [
    ['bot_memory', { action, ...privateArgs }],
    ['mcp__cindy_memory__call_tool', { name: `memory_${action}`, args: privateArgs }],
    [`mcp__cindy_memory__memory_${action}`, privateArgs],
  ] as const;
  for (const [tool, input] of calls) {
    const phase = publicToolPhase(tool, input);
    expect(phase).toBe(expected);
    expect(publicToolResultPhase(phase)).toBe('reviewing-memory');
    const prompt = workingStatusPrompt(phase, 'en', null);
    expect(prompt).not.toMatch(/SECRET|private|filename|sources|bot_memory|mcp__/);
    expect(prompt).toContain('long-term memory');
    expect(validateWorkingStatusCopy(caption, phase)).toBe(caption);
    expect(validateWorkingStatusCopy('Working on it…', phase)).toBeNull();
  }
});

it.each(['Deleted the memory', 'Consolidated memory', 'Organized memory', '已删除记忆', '記憶已合併', '记忆整理好了'])('rejects memory maintenance completion claims: %s', (text) => {
  expect(validateWorkingStatusCopy(text)).toBeNull();
});
