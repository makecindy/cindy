import { HOOK_EVENTS, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { NativeRecoveryObserver } from '../shared/native-recovery-observer.js';

const events = ['PreCompact', 'PostCompact', 'Stop', 'StopFailure'] as const;

export function claudeNativeRecoveryHooks(observer?: NativeRecoveryObserver, sessionId?: string) {
  const sink = sessionId ? observer?.(sessionId) : undefined;
  if (!sink) return undefined;
  const hooks: Partial<Record<(typeof events)[number], HookCallbackMatcher[]>> = {};
  for (const event of events) {
    if (!HOOK_EVENTS.includes(event)) continue;
    hooks[event] = [{ hooks: [async (input, _id, { signal }) => {
      if (signal.aborted || input.hook_event_name !== event) return {};
      // Publish only boundary metadata. Native inputs can contain paths, transcripts and prompts.
      switch (input.hook_event_name) {
        case 'PreCompact':
        case 'PostCompact':
          sink.publish('claude-code', event, { trigger: input.trigger });
          break;
        case 'Stop':
          sink.publish('claude-code', event, { stop_hook_active: input.stop_hook_active });
          break;
        case 'StopFailure':
          sink.publish('claude-code', event, { error: input.error });
          break;
      }
      return {};
    }] }];
  }
  return Object.keys(hooks).length ? hooks : undefined;
}
