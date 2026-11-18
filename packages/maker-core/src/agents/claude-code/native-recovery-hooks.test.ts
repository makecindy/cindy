import { expect, it, vi } from 'vitest';
import { claudeNativeRecoveryHooks } from './native-recovery-hooks.js';

// Unit: exercise the real SDK callback configuration. Existing tool callback
// tests do not cover compaction or stopping. An installed compact hook
// must publish metadata without disclosing the native conversation summary.
it('omits callbacks without a subscriber and drops cancelled callbacks', async () => {
  let subscribed = false;
  const publish = vi.fn();
  const observer = () => subscribed ? { publish } : undefined;
  expect(claudeNativeRecoveryHooks(observer, 'task')).toBeUndefined();
  subscribed = true;
  const hooks = claudeNativeRecoveryHooks(observer, 'task')!;
  const hook = hooks.PostCompact![0].hooks[0];
  const signal = new AbortController();
  const input = {
    hook_event_name: 'PostCompact' as const,
    trigger: 'auto' as const,
    compact_summary: 'private summary',
    transcript_path: '/private/transcript',
    session_id: 'native',
    cwd: '/private',
  };
  expect(await hook(input, undefined, { signal: signal.signal })).toEqual({});
  expect(publish).toHaveBeenCalledExactlyOnceWith('claude-code', 'PostCompact', { trigger: 'auto' });
  signal.abort();
  await hook(input, undefined, { signal: signal.signal });
  expect(publish).toHaveBeenCalledTimes(1);
});
