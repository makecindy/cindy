import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import { SessionPatchStage, type SessionPatch } from '../sessionPatchStage';

describe('session patch backpressure', () => {
  const stages: SessionPatchStage[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stages.splice(0).forEach((stage) => stage.dispose()); vi.useRealTimers(); });
  function make(writable = () => true, send = vi.fn(async (_item: SessionPatch, _current: () => boolean) => {})) {
    const stage = new SessionPatchStage(undefined, writable, send, vi.fn());
    stages.push(stage);
    return { stage, send };
  }

  it('merges fields and explicit nulls while retaining every task terminal state', async () => {
    const { stage, send } = make();
    for (let i = 0; i < 2026; i++) stage.enqueue({ sessionId: 'a', patch: { title: String(i) } });
    stage.enqueue({ sessionId: 'a', patch: { model: null } });
    stage.enqueue({ sessionId: 'b', patch: { status: 'deleted' } });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(send.mock.calls.map(([item]) => item)).toEqual([
      { sessionId: 'a', patch: { title: '2025', model: null } },
      { sessionId: 'b', patch: { status: 'deleted' } },
    ]);
  });

  it('pauses a silent peer while another peer progresses, then paces its backlog', async () => {
    let writable = false;
    const slow = make(() => writable);
    const fast = make();
    for (let i = 0; i < 40; i++) slow.stage.enqueue({ sessionId: String(i), patch: { status: 'archived' } });
    fast.stage.enqueue({ sessionId: 'healthy', patch: { title: 'latest' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow.send).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledOnce();
    writable = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(slow.send).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow.send).toHaveBeenCalledTimes(40);
  });

  it('retains a patch rejected by queue admission', async () => {
    const { stage, send } = make();
    send.mockRejectedValueOnce(new DeviceLinkError('BACKPRESSURE', 'full'));
    stage.enqueue({ sessionId: 'a', patch: { status: 'deleted' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not deliver an older authorized patch after a newer update or unsubscribe', async () => {
    let release!: () => void;
    const sent: SessionPatch[] = [];
    const send = vi.fn(async (item: SessionPatch, current: () => boolean) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (current()) sent.push(item);
    });
    const { stage } = make(() => true, send);
    stage.enqueue({ sessionId: 'a', patch: { title: 'old' } });
    await vi.advanceTimersByTimeAsync(250);
    stage.enqueue({ sessionId: 'a', patch: { title: 'new' } });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    stage.dispose();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([]);
  });
});
