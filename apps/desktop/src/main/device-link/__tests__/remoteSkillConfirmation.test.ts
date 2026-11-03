import { describe, expect, it, vi } from 'vitest';
import { confirmRemoteSkillMutation, isRemoteSkillApproval } from '../remoteSkillConfirmation';
import { REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';

const receipt = {
  operationId: 'op',
  phase: 'confirmation',
  confirmation: { kind: 'uninstall', name: 'fixture', requestId: 'request' },
};
describe('remote Skill native confirmation', () => {
  it('reads Host facts and sends the exact request after a native decision', async () => {
    const invoke = vi.fn(async (action) =>
      action === 'operation' ? receipt : { operationId: 'op', phase: 'running' },
    );
    const prompt = vi.fn(async () => true),
      current = vi.fn();
    await confirmRemoteSkillMutation({ invoke, prompt, current }, 'op');
    expect(prompt).toHaveBeenCalledWith(receipt.confirmation);
    expect(invoke).toHaveBeenLastCalledWith('answer', {
      operationId: 'op',
      requestId: 'request',
      accepted: true,
    });
  });
  it('never approves after navigation, account switch or target revocation during the dialog', async () => {
    let valid = true;
    const invoke = vi.fn(async () => receipt);
    await expect(
      confirmRemoteSkillMutation(
        {
          invoke,
          current: () => {
            if (!valid) throw Error('stale');
          },
          prompt: async () => {
            valid = false;
            return true;
          },
        },
        'op',
      ),
    ).rejects.toThrow('stale');
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('blocks direct generic Renderer approval while preserving ordinary remote reads and plugin actions', () => {
    expect(
      isRemoteSkillApproval(REMOTE_RESOURCE_INVOKE_CHANNEL, [
        { collectionId: 'skills', actionId: 'management:answer' },
      ]),
    ).toBe(true);
    expect(
      isRemoteSkillApproval(REMOTE_RESOURCE_INVOKE_CHANNEL, [
        { collectionId: 'skills', actionId: 'management:snapshot' },
      ]),
    ).toBe(false);
    expect(
      isRemoteSkillApproval(REMOTE_RESOURCE_INVOKE_CHANNEL, [
        { collectionId: 'plugins', actionId: 'management:answer' },
      ]),
    ).toBe(false);
  });
  it('rejects malformed Host confirmation before opening the native dialog', async () => {
    const prompt = vi.fn();
    await expect(
      confirmRemoteSkillMutation(
        {
          invoke: async () => ({
            ...receipt,
            confirmation: { ...receipt.confirmation, kind: 'arbitrary' },
          }),
          current: () => {},
          prompt,
        },
        'op',
      ),
    ).rejects.toThrow('INVALID_RESPONSE');
    expect(prompt).not.toHaveBeenCalled();
  });
});
