import { describe, expect, it, vi } from 'vitest';
import { deliverPassportDictation } from '../passportDictationDelivery';

const draft = { token: 'once', sessionId: 'task', text: '继续这个任务', ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 } };
describe('hardware-confirmed Passport delivery', () => {
  it('acknowledges only an accepted message', async () => {
    const send = vi.fn(async () => true), acknowledge = vi.fn(async () => {});
    await expect(deliverPassportDictation(draft, () => true, send, acknowledge)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(draft.text);
    expect(acknowledge).toHaveBeenCalledWith('once', true);
  });
  it('does not send after an owner or task-view change', async () => {
    const send = vi.fn(async () => true), acknowledge = vi.fn(async () => {});
    await expect(deliverPassportDictation(draft, () => false, send, acknowledge)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith('once', false);
  });
  it('returns a rejected send to hardware review without retrying', async () => {
    const send = vi.fn(async () => false), acknowledge = vi.fn(async () => {});
    await deliverPassportDictation(draft, () => true, send, acknowledge);
    expect(send).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith('once', false);
  });
  it('reports a thrown send failure to hardware review', async () => {
    const send = vi.fn(async () => { throw new Error('blocked'); }), acknowledge = vi.fn(async () => {});
    await expect(deliverPassportDictation(draft, () => true, send, acknowledge)).rejects.toThrow('blocked');
    expect(acknowledge).toHaveBeenCalledWith('once', false);
  });
});
