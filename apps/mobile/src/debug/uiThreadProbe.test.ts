import { describe, expect, it, vi } from 'vitest';
import { createUiThreadProbe, UI_THREAD_UNANSWERED_MS } from './uiThreadProbe';

function harness() {
  let time = 1_000;
  const replies: ((sentAt: number, arrivedAt: number) => void)[] = [];
  const onLag = vi.fn();
  const onUnanswered = vi.fn();
  const sent: number[] = [];
  const probe = createUiThreadProbe({
    now: () => time,
    ping: (sentAt, arrived) => { sent.push(sentAt); replies.push(arrived); },
    onLag,
    onUnanswered,
  });
  return { probe, sent, replies, onLag, onUnanswered, advance: (ms: number) => { time += ms; }, now: () => time };
}

describe('createUiThreadProbe', () => {
  it('measures lag up to arrival on the UI runtime, not JS reading the reply', () => {
    const h = harness();
    h.probe.sample();
    h.replies[0](h.sent[0], h.sent[0] + 120);
    h.advance(5_000);
    expect(h.onLag).toHaveBeenCalledWith(120);
  });

  it('keeps one ping outstanding', () => {
    const h = harness();
    h.probe.sample();
    h.advance(100);
    h.probe.sample();
    expect(h.sent).toHaveLength(1);
  });

  it('reports a ping with no answer once (it cannot tell a hung UI thread from a busy JS thread), so a force quit still leaves evidence', () => {
    const h = harness();
    h.probe.sample();
    h.advance(UI_THREAD_UNANSWERED_MS - 1);
    h.probe.sample();
    expect(h.onUnanswered).not.toHaveBeenCalled();
    h.advance(1);
    h.probe.sample();
    h.advance(2_000);
    h.probe.sample();
    expect(h.onUnanswered).toHaveBeenCalledTimes(1);
    expect(h.onUnanswered).toHaveBeenCalledWith(UI_THREAD_UNANSWERED_MS);
  });

  it('ignores a late reply from before a lifecycle reset', () => {
    const h = harness();
    h.probe.sample();
    h.probe.reset();
    h.replies[0](h.sent[0], h.now() + 30_000);
    expect(h.onLag).not.toHaveBeenCalled();
    h.advance(10);
    h.probe.sample();
    expect(h.sent).toHaveLength(2);
  });

  it('survives a ping that cannot be scheduled', () => {
    const onLag = vi.fn();
    const ping = vi.fn(() => { throw new Error('no runtime'); });
    const probe = createUiThreadProbe({ ping, onLag, onUnanswered: vi.fn() });
    expect(() => { probe.sample(); probe.sample(); }).not.toThrow();
    expect(ping).toHaveBeenCalledTimes(2);
  });
});
