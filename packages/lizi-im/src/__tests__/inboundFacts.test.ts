import { describe, expect, it } from 'vitest';
import { buildInboundMessageFacts } from '../inboundFacts';

describe('inbound message facts', () => {
  it('does not rewrite an ordinary message', () => {
    expect(buildInboundMessageFacts({ text: '请解释这段话', attachmentCount: 0 })).toBe('');
  });
  it.each([
    { text: '', invoked: true, attachmentCount: 0 },
    { text: '', invoked: true, hasReply: true, attachmentCount: 0 },
    { text: '', attachmentCount: 2 },
    { text: '', attachmentCount: 0, unavailable: ['photo：下载失败'] },
  ])('reports facts without inventing a request: %j', (input) => {
    const note = buildInboundMessageFacts(input);
    expect(note).toContain('不是用户原话');
    expect(note).toContain('未附加文字正文');
    expect(note).not.toMatch(/请检查|请查看|看看|继续|重新发送/);
    expect(note.includes('实际提供了')).toBe(input.attachmentCount > 0);
  });
  it('distinguishes delivered files from failed files and keeps names as data', () => {
    const note = buildInboundMessageFacts({
      text: '分析这两张图', attachmentCount: 1,
      unavailable: ['second.png：超过大小上限'],
    });
    expect(note).toContain('实际提供了 1 个附件');
    expect(note).toContain('second.png：超过大小上限');
    expect(note).not.toContain('2 个附件');
  });
});
