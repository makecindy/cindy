import { describe, expect, it, vi } from 'vitest';

// sessionOperationsHost 会拉起 electron / localDb / im binding 等主进程依赖,
// 这里只验证纯函数 messageTextForDraft,把重依赖全部挡掉。
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] } }));
vi.mock('../../im/binding.js', () => ({ bindingStore: { findByTarget: () => null, runExclusive: (task: () => unknown) => task() } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({}), tryGetDbClient: () => null }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ updateSessionInDb: async () => ({}) }));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({ emitSessionCreated: () => undefined }));
vi.mock('../../localDb/schema.js', () => ({ messages: {}, orcaTeams: {}, orcaWorkers: {}, sessions: {} }));
vi.mock('../../maker-orchestration/fork.js', () => ({ forkSessionAtMessage: async () => ({ id: 'forked' }) }));
vi.mock('../../secondary-windows.js', () => ({ openSecondaryWindow: () => undefined }));

import { messageTextForDraft } from '../sessionOperationsHost.js';

describe('messageTextForDraft', () => {
  it('unwraps a JSON-encoded plain string without leaking quotes', () => {
    // DB 里 user 消息正文就是这个形态(见 main/__tests__/fork.test.ts 的 content: '"hello"')。
    expect(messageTextForDraft('"hello"')).toBe('hello');
  });

  it('joins a plain string array instead of dropping it', () => {
    expect(messageTextForDraft('["a","b"]')).toBe('a\nb');
  });

  it('takes text from content blocks', () => {
    expect(messageTextForDraft('[{"type":"text","text":"x"},{"type":"image"}]')).toBe('x');
  });

  it('falls back to the raw string when the content is not JSON', () => {
    expect(messageTextForDraft('hello')).toBe('hello');
  });

  it('returns an empty string for non-string or blank content', () => {
    expect(messageTextForDraft(undefined)).toBe('');
    expect(messageTextForDraft('   ')).toBe('');
  });
});
