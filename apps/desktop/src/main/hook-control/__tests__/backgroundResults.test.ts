import { describe, expect, it, vi } from 'vitest';
import { createBackgroundResults } from '../backgroundResults';
import type { HookContinuationWatchRequest, HookSessionRunner } from '../dispatcher';

function fixture(key = 'telegram:dm:bot:user:g0') {
  let watch!: HookContinuationWatchRequest;
  let generation = 0;
  const send = vi.fn(() => true);
  const sender = vi.fn(() => send);
  const get = vi.fn(() => 'session');
  const allowed = vi.fn(() => true);
  const owned = vi.fn(() => false);
  const cancel = vi.fn(() => watch.onEnd({ status: 'error', finalText: '', errorMessage: 'cancelled', durationMs: 0 }));
  const watchContinuation = vi.fn((req: HookContinuationWatchRequest) => { watch = req; req.onClaim(); return cancel; });
  const output = createBackgroundResults({
    bindings: { get, set() {}, remove() {}, findBySession: () => [{ connectionId: 'conn', externalKey: key }] },
    runner: { watchContinuation } as unknown as HookSessionRunner,
    sender, allowed, owned, generation: () => generation, log: { warn: vi.fn() },
  });
  return { output, send, sender, get, allowed, owned, watchContinuation, cancel,
    watch: () => watch, rotate: () => { generation++; } };
}
const result = { status: 'ok' as const, finalText: '自动执行结果', errorMessage: null, durationMs: 10 };

describe('IM session background results', () => {
  it.each([
    'telegram:dm:bot:user:g0', 'slack:T:C:1.2', 'slack:dm:T1:U1:g2',
    'team-slack:C1:1.1', 'T1:C1:1.1', 'dm:U1:g2', 'dm:T1:U1:g2',
  ])('forwards %s once, including attachments', (key) => {
    const f = fixture(key);
    f.output.start('session', '/work');
    f.output.start('session', '/work');
    expect(f.watchContinuation).toHaveBeenCalledTimes(1);
    const outcome = { ...result, attachments: [{ mimeType: 'text/plain', dataBase64: 'YQ==', name: 'a.txt' }] };
    f.watch().onEnd(outcome);
    f.watch().onEnd(outcome);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn.end', payload: expect.objectContaining({
      status: 'ok', finalText: result.finalText, usage: { durationMs: 10 },
      background: true, externalKey: key, attachments: outcome.attachments,
    }) }));
  });

  it.each(['x:post:1', 'discord:channel-1', 'arbitrary', 'dm:U1:invalid', 'T1:C1:invalid'])(
    'does not observe unsupported lane %s', (key) => {
      const f = fixture(key);
      f.output.start('session', '/work');
      expect(f.watchContinuation).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it('excludes old servers and turns already owned by normal IM/reopen delivery', () => {
    const f = fixture();
    f.owned.mockReturnValue(true);
    f.output.start('session', '/work');
    expect(f.watchContinuation).not.toHaveBeenCalled();
    f.owned.mockReturnValue(false);
    f.sender.mockReturnValue(undefined as never);
    f.output.start('session', '/work');
    expect(f.watchContinuation).not.toHaveBeenCalled();
  });

  it.each(['binding', 'directory', 'connection', 'account'] as const)('discards late results after %s changes', (kind) => {
    const f = fixture();
    f.output.start('session', '/work');
    f.watch().onSettling?.();
    if (kind === 'binding') f.get.mockReturnValue('replacement');
    if (kind === 'directory') f.allowed.mockReturnValue(false);
    if (kind === 'connection') f.sender.mockReturnValue(vi.fn());
    if (kind === 'account') f.rotate();
    f.watch().onEnd(result);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('teardown suppresses the observer cancellation result', () => {
    const f = fixture();
    f.output.start('session', '/work');
    f.output.clear();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('a cancelled preflight cannot claim the next turn', () => {
    const f = fixture();
    f.output.start('session', '/work');
    const abandoned = f.watch();
    f.output.cancel('session');
    f.output.start('session', '/work');
    abandoned.onEnd(result);
    expect(f.send).not.toHaveBeenCalled();
    f.watch().onEnd(result);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('ignores empty output and admits the following turn during attachment collection', () => {
    const f = fixture();
    f.output.start('session', '/work');
    const first = f.watch();
    first.onSettling?.();
    f.output.start('session', '/work');
    expect(f.watchContinuation).toHaveBeenCalledTimes(2);
    first.onEnd({ ...result, finalText: '' });
    f.watch().onEnd(result);
    expect(f.send).toHaveBeenCalledOnce();
  });
});
