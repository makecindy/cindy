import { describe, expect, it, vi } from 'vitest';
import { createRemoteOrcaInputAdmission, remoteOrcaInputDigest } from '../orcaRemoteInputProvenance.js';
import { stampTrustedDesktopQueuedOrigin, stampTrustedDeviceLinkQueuedOrigin } from '../makerSendTransaction.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

function setup() {
  let owner = 1;
  const lead = { leadDeviceId: 'lead-pc', leadDeviceName: 'Lead', leadSessionId: 'lead-task', leadTitle: 'Lead', workerLabel: 'worker' };
  const row = { status: 'active', orcaRemoteLead: lead as typeof lead & { releasedAt?: number } };
  const caller = { controllerDeviceId: 'lead-pc', sharedTask: undefined as unknown };
  const raw = { clientId: 'input-1', text: 'do work', persistedContent: 'do work',
    origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'do work' } } as AgentInputQueuedMessage;
  const queued = stampTrustedDeviceLinkQueuedOrigin(stampTrustedDesktopQueuedOrigin(raw, true), true,
    { deviceId: 'lead-pc', name: 'Lead', platform: 'desktop' });
  const invoke = vi.fn(async () => ({ ok: true as const, result: true }));
  const readSession = vi.fn(async () => row);
  const admit = createRemoteOrcaInputAdmission({ owner: () => owner, caller: () => caller, readSession, invoke });
  return { raw, queued, invoke, admit, row, caller, readSession, changeOwner: () => { owner++; } };
}

describe('remote Orca input admission', () => {
  it('restores the exact verified Lead input after ordinary wire cleanup', async () => {
    const h = setup();
    expect(h.queued.origin).toBeUndefined();
    const accepted = await h.admit('worker-task', h.raw, h.queued);
    expect(accepted.origin).toEqual(h.raw.origin);
    expect(accepted.sourceDevice).toBeUndefined();
    expect(h.invoke).toHaveBeenCalledWith('lead-pc', 'maker:orca:remote-worker:verify-input',
      ['worker-task', 'input-1', remoteOrcaInputDigest(h.raw), 'lead-task']);
    expect(h.queued.origin).toBeUndefined();
  });
  it.each(['wrong-device', 'shared-guest', 'released', 'archived', 'wrong-client'])('rejects %s before asking for proof', async reason => {
    const h = setup();
    if (reason === 'wrong-device') h.caller.controllerDeviceId = 'another-pc';
    if (reason === 'shared-guest') h.caller.sharedTask = {};
    if (reason === 'released') h.row.orcaRemoteLead.releasedAt = 1;
    if (reason === 'archived') h.row.status = 'archived';
    if (reason === 'wrong-client') h.raw.clientId = 'another-input';
    expect(await h.admit('worker-task', h.raw, h.queued)).toBe(h.queued);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('does not trust a matching device and forged Orca label without runtime proof', async () => {
    const h = setup();h.invoke.mockResolvedValue({ ok: true, result: false });
    expect(await h.admit('worker-task', h.raw, h.queued)).toBe(h.queued);
  });
  it('keeps old-peer/network failure on the existing untrusted input path', async () => {
    const h = setup();h.invoke.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
    expect(await h.admit('worker-task', h.raw, h.queued)).toBe(h.queued);
  });
  it.each(['owner', 'release', 'rebind'])('rejects %s changes during verification', async reason => {
    const h = setup();h.invoke.mockImplementation(async () => {
      if (reason === 'owner') h.changeOwner();
      if (reason === 'release') h.row.orcaRemoteLead = { ...h.row.orcaRemoteLead, releasedAt: 1 };
      if (reason === 'rebind') h.row.orcaRemoteLead = { ...h.row.orcaRemoteLead, leadSessionId: 'other-lead' };
      return { ok: true, result: true };
    });
    expect(await h.admit('worker-task', h.raw, h.queued)).toBe(h.queued);
  });
});
