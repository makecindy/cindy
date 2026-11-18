import { expect, it, vi } from 'vitest';
import { claudeNativeRecoveryHooks } from './native-recovery-hooks.js';

// Unit: exercise the real SDK callback configuration. Existing tool callback
// tests do not cover compaction or stopping. A single subscribed boundary
// must publish metadata without disclosing the native conversation summary.
it('installs only subscribed boundaries and drops disabled or cancelled callbacks', async () => {
  let subscribed = false;
  const publish = vi.fn();
  const observer = { enabled: (_session: string, event: string) => subscribed && event === 'PostCompact', publish };
  expect(claudeNativeRecoveryHooks(observer, 'task')).toBeUndefined();
  subscribed = true;
  const hooks = claudeNativeRecoveryHooks(observer, 'task')!;
  expect(Object.keys(hooks)).toEqual(['PostCompact']);
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
  expect(publish).toHaveBeenCalledExactlyOnceWith('task', { hook_event_name: 'PostCompact', trigger: 'auto' });
  subscribed = false;
  await hook(input, undefined, { signal: signal.signal });
  subscribed = true;
  signal.abort();
  await hook(input, undefined, { signal: signal.signal });
  expect(publish).toHaveBeenCalledTimes(1);
});
