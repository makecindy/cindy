import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';
import { speechChunks, speechText, VoiceReplyTracker } from '../VoiceReplyTracker';
import { Pcm16Decoder } from '../PcmSpeechPlayer';

const message = (clientId: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}) =>
  ({ clientId, role, content: 'Hello', ...extra }) as ChatMessage;
describe('voice reply correlation', () => {
  it('excludes history, commentary, tool/subagent/group replies and failed turns', () => {
    const tracker = new VoiceReplyTracker();
    expect(tracker.take([message('old', 'assistant', { turnCompleted: true })])).toBeNull();
    tracker.expect('mine');
    const messages = [
      message('mine', 'user'),
      message('progress', 'assistant', { assistantPhase: 'commentary', turnCompleted: true }),
      message('child', 'assistant', { parentToolUseId: 'tool', turnCompleted: true }),
      message('group', 'assistant', { explicitDelivery: true, turnCompleted: true }),
      message('failed', 'assistant', { turnCompleted: false }),
    ];
    expect(tracker.take(messages)).toBeNull();
    messages.push(message('answer', 'assistant', { content: '**Done**', turnCompleted: true }));
    expect(tracker.take(messages)).toEqual({ id: 'answer', text: 'Done' });
    expect(tracker.take(messages)).toBeNull();
  });
  it('waits for a queued input and abandons speech ownership when another input takes over', () => {
    const tracker = new VoiceReplyTracker();
    tracker.expect('queued');
    expect(tracker.take([message('old', 'assistant', { turnCompleted: true })])).toBeNull();
    expect(
      tracker.take([
        message('queued', 'user'),
        message('other', 'user'),
        message('answer', 'assistant', { turnCompleted: true }),
      ]),
    ).toBeNull();
  });
  it('waits for an outgoing reply hook to finish before reading its final text', () => {
    const tracker = new VoiceReplyTracker();
    tracker.expect('mine');
    const messages = [
      message('mine', 'user'),
      message('reply', 'assistant', { turnCompleted: true, ghostReplyPending: true }),
    ];
    expect(tracker.take(messages)).toBeNull();
    messages[1].ghostReplyPending = false;
    expect(tracker.take(messages)?.id).toBe('reply');
  });
});

it('reads prose and link labels without executing markup or speaking code/image URLs', () => {
  expect(
    speechText(
      '## **Hello**\n[world](https://example.test) ![image](https://image.test)\n```js\nsecretCode()\n```',
    ),
  ).toBe('Hello world');
});

it('chunks the whole reply without splitting surrogate pairs or silently truncating it', () => {
  const text = '🙂'.repeat(4000);
  const chunks = speechChunks(text);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every((part) => part.length <= 3500 && !/^[\uDC00-\uDFFF]/.test(part))).toBe(true);
});

it('decodes signed PCM across odd byte boundaries and refuses a truncated last sample', () => {
  const decoder = new Pcm16Decoder();
  expect([...decoder.decode(new Uint8Array([0]).buffer)]).toEqual([]);
  expect([...decoder.decode(new Uint8Array([128, 255, 127, 0]).buffer)]).toEqual([
    -1,
    32767 / 32768,
  ]);
  expect(() => decoder.finish()).toThrow('Incomplete');
  expect([...decoder.decode(new Uint8Array([0]).buffer)]).toEqual([0]);
  expect(() => decoder.finish()).not.toThrow();
});
