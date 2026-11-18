import { HOOK_EVENTS, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeRecoveryEvent =
  | { hook_event_name: 'PreCompact' | 'PostCompact'; trigger: 'manual' | 'auto' }
  | { hook_event_name: 'Stop'; stop_hook_active: boolean }
  | { hook_event_name: 'StopFailure'; error: string };

export interface ClaudeRecoveryObserver {
  enabled(sessionId: string, event: ClaudeRecoveryEvent['hook_event_name']): boolean;
  publish(sessionId: string, event: ClaudeRecoveryEvent): void;
}

const events = ['PreCompact', 'PostCompact', 'Stop', 'StopFailure'] as const;

export function claudeNativeRecoveryHooks(observer?: ClaudeRecoveryObserver, sessionId?: string) {
  if (!observer || !sessionId) return undefined;
  const hooks: Partial<Record<ClaudeRecoveryEvent['hook_event_name'], HookCallbackMatcher[]>> = {};
  for (const event of events) {
    if (!HOOK_EVENTS.includes(event) || !observer.enabled(sessionId, event)) continue;
    hooks[event] = [{ hooks: [async (input, _id, { signal }) => {
      if (signal.aborted || input.hook_event_name !== event || !observer.enabled(sessionId, event)) return {};
      // Publish only boundary metadata. Native inputs can contain paths, transcripts and prompts.
      switch (input.hook_event_name) {
        case 'PreCompact':
        case 'PostCompact':
          observer.publish(sessionId, { hook_event_name: input.hook_event_name, trigger: input.trigger });
          break;
        case 'Stop':
          observer.publish(sessionId, { hook_event_name: 'Stop', stop_hook_active: input.stop_hook_active });
          break;
        case 'StopFailure':
          observer.publish(sessionId, { hook_event_name: 'StopFailure', error: input.error });
          break;
      }
      return {};
    }] }];
  }
  return Object.keys(hooks).length ? hooks : undefined;
}
