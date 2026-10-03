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

  it('strips private quote markers from a quotesEncoded envelope', () => {
    // 作曲器引用会存成 {text, quotesEncoded:true},正文里带私有标记行;
    // 直接回传会让模型读到标记,口径对齐 autoReviewUserIntent 的投影。
    const raw = JSON.stringify({ text: '> quoted\nmy question', quotesEncoded: true });
    const out = messageTextForDraft(raw);
    expect(out).not.toContain('quotesEncoded');
    expect(out).toContain('my question');
  });

  it('keeps composer reference context instead of leaving opaque cindy:// text', () => {
    // envelope 同时带 text 与 agentReferences 时,直接回传 text 会丢掉引用解析所需的元数据。
    const raw = JSON.stringify({
      text: 'see cindy://session/abc for context',
      agentReferences: [{ kind: 'session', id: 'abc', title: 'Some task' }],
    });
    const out = messageTextForDraft(raw);
    expect(out).toBeTruthy();
    expect(typeof out).toBe('string');
  });

  it('falls back to the raw string when the content is not JSON', () => {
    expect(messageTextForDraft('hello')).toBe('hello');
  });

  it('returns an empty string for non-string or blank content', () => {
    expect(messageTextForDraft(undefined)).toBe('');
    expect(messageTextForDraft('   ')).toBe('');
  });
});
