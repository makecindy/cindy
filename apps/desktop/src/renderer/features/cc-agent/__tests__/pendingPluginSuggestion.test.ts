import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  readyPendingPluginSuggestion,
  startPendingPluginSuggestion,
  takePendingPluginSuggestion,
  type PluginSuggestionRequest,
} from '../pendingPluginSuggestion';
const request: PluginSuggestionRequest = {
  ownerId: 'a',
  targetKey: 'local',
  workingDir: null,
  model: 'test',
  effort: 'medium',
  permissionMode: 'default',
  files: [],
  suggestion: {
    id: 'plugin:test:one',
    category: 'email',
    label: 'Mail',
    prompt: 'My full prompt',
    pluginId: 'test',
  },
};
beforeEach(() => cancelPendingPluginSuggestion());
describe('installation continuation', () => {
  it('preserves the full task and consumes it exactly once only after successful setup action', () => {
    const nonce = startPendingPluginSuggestion(request);
    expect(readyPendingPluginSuggestion(nonce, 'a', 'other')).toBeNull();
    expect(readyPendingPluginSuggestion(nonce, 'a', 'test')).toBe(nonce);
    expect(takePendingPluginSuggestion(nonce, 'a', 'local')?.suggestion.prompt).toBe(
      'My full prompt',
    );
    expect(takePendingPluginSuggestion(nonce, 'a', 'local')).toBeNull();
  });
  it('ignores completion after cancellation or after another selection', () => {
    const old = startPendingPluginSuggestion(request);
    cancelPendingPluginSuggestion(old);
    expect(readyPendingPluginSuggestion(old, 'a', 'test')).toBeNull();
    const next = startPendingPluginSuggestion({
      ...request,
      suggestion: { ...request.suggestion, prompt: 'New' },
    });
    expect(readyPendingPluginSuggestion(old, 'a', 'test')).toBeNull();
    expect(getPendingPluginSuggestion()?.nonce).toBe(next);
  });
  it('does not resume under another owner or a changed execution target', () => {
    const nonce = startPendingPluginSuggestion(request);
    expect(readyPendingPluginSuggestion(nonce, 'b', 'test')).toBeNull();
    readyPendingPluginSuggestion(nonce, 'a', 'test');
    expect(takePendingPluginSuggestion(nonce, 'a', 'remote')).toBeNull();
    expect(getPendingPluginSuggestion()).toBeNull();
  });
});
