import { describe, expect, it, vi } from 'vitest';
import {
  createBotExistingSessionDelivery, ExistingSessionDeliveryError, existingSessionDeliveryClientId,
  type ExistingSessionDeliveryDeps, type ExistingSessionDeliveryInput,
} from '../botExistingSessionDelivery';

const input: ExistingSessionDeliveryInput = { callerSessionId: 'bot-main', targetSessionId: 'original-fable', message: 'Confirm receipt only.', idempotencyKey: 'same-delivery' };
function harness() {
  const accepted = new Map<string, { message: string }>();
  let valid = true;
  const check = () => { if (!valid) throw new ExistingSessionDeliveryError('CONTEXT_CHANGED', 'changed'); };
  const confirm = vi.fn(async () => true);
  const commit = vi.fn((request: ExistingSessionDeliveryInput, clientId: string) => { accepted.set(clientId, { message: request.message }); });
  const dispose = vi.fn();
  const deps: ExistingSessionDeliveryDeps = {
    capture: vi.fn(async () => ({ ownerScope: 'owner:1', assertCurrent: check, validate: async () => check(), confirm, dispose })),
    withTargetLock: async (_id, action) => action(),
    readAccepted: vi.fn(async (_id, clientId) => accepted.get(clientId) ?? null),
    prepare: vi.fn(async (request, clientId) => () => commit(request, clientId)),
    flush: vi.fn(async () => undefined),
  };
  return { deps, service: createBotExistingSessionDelivery(deps), accepted, confirm, commit, dispose, invalidate: () => { valid = false; } };
}

describe('existing Session delivery admission', () => {
  it('admits one exact target/message after approval, and flushes before returning queued', async () => {
    const h = harness();
    expect(await h.service.send(input)).toEqual({ ok: true, targetSessionId: input.targetSessionId, wakeKind: 'queued', reused: false });
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(input, existingSessionDeliveryClientId(input));
    expect(h.deps.flush).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it('does not prepare or enqueue when the user declines', async () => {
    const h = harness(); h.confirm.mockResolvedValue(false);
    expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'TARGET_NOT_AUTHORIZED' });
    expect(h.deps.prepare).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  });
  it('rechecks authority when approval arrives after a permission or owner change', async () => {
    const h = harness(); h.confirm.mockImplementation(async () => { h.invalidate(); return true; });
    expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'CONTEXT_CHANGED' });
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('rechecks authority after async queue preparation', async () => {
    const h = harness();
    h.deps.prepare = vi.fn(async () => { h.invalidate(); return () => h.commit(input, 'bad'); });
    expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'CONTEXT_CHANGED' });
    expect(h.commit).not.toHaveBeenCalled();
  });
  it('coalesces concurrent retries without holding the target lock during approval', async () => {
    const h = harness(); let finish!: (value: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let locked = false;
    h.deps.withTargetLock = async (_id, action) => { locked = true; try { return await action(); } finally { locked = false; } };
    const first = h.service.send(input);
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(locked).toBe(false);
    const second = h.service.send(input);
    finish(true);
    expect((await Promise.all([first, second])).every(r => r.ok)).toBe(true);
    expect(h.confirm).toHaveBeenCalledOnce(); expect(h.commit).toHaveBeenCalledOnce();
  });
  it('uses the durable receipt on a later service instance without reapproval or redelivery', async () => {
    const h = harness(); await h.service.send(input);
    h.confirm.mockClear(); h.commit.mockClear();
    const restarted = createBotExistingSessionDelivery(h.deps);
    expect(await restarted.send(input)).toMatchObject({ ok: true, reused: true });
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  });
  it('gives concurrent callers the same uncertain outcome after queue admission', async () => {
    const h = harness(); let finish!: (value: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(h.deps.flush).mockRejectedValueOnce(new Error('storage unavailable'));
    const first = h.service.send(input);
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    const second = h.service.send(input);
    finish(true);
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'DELIVERY_UNVERIFIED' }),
      expect.objectContaining({ ok: false, errorCode: 'DELIVERY_UNVERIFIED' }),
    ]);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(await h.service.send(input)).toMatchObject({ ok: true, reused: true });
    expect(h.commit).toHaveBeenCalledOnce();
  });
  it('rejects reuse of a receipt key with a different body', async () => {
    const h = harness(); await h.service.send(input);
    expect(await h.service.send({ ...input, message: 'Different command' })).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(h.commit).toHaveBeenCalledOnce();
  });
  it('does not claim rejection after admission if durable flush fails, and retries the same receipt', async () => {
    const h = harness(); vi.mocked(h.deps.flush).mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await h.service.send(input)).toMatchObject({ ok: false, errorCode: 'DELIVERY_UNVERIFIED' });
    expect(await h.service.send(input)).toMatchObject({ ok: true, reused: true });
    expect(h.commit).toHaveBeenCalledOnce();
  });
  it('rechecks the receipt after confirmation to handle a concurrent accepted delivery', async () => {
    const h = harness(); h.confirm.mockImplementation(async () => {
      h.accepted.set(existingSessionDeliveryClientId(input), { message: input.message }); return true;
    });
    expect(await h.service.send(input)).toMatchObject({ ok: true, reused: true });
    expect(h.commit).not.toHaveBeenCalled();
  });
});
