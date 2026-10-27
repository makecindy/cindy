import { describe, expect, it, vi } from 'vitest';
import { GhostSubscriptionGateway } from '../subscriptionGateway.js';
import type { GhostPipeHarnessEvent } from '@cindy/plugin-protocol';
import type { InstalledGhost } from '../../../shared/ghost.js';

const event: Omit<GhostPipeHarnessEvent, 'seq' | 'ts'> = {
  type: 'harness-event',
  topic: 'tool',
  name: 'tool.started',
  data: {
    revision: 1,
    sessionId: 's',
    runtimeId: 'r',
    turnGeneration: 1,
    agent: 'pi',
    toolId: 'opaque',
  },
};

function fixture() {
  const ghost = {
    enabled: true,
    dir: '/unused/a',
    approval: { state: 'approved', revision: '1' },
    harnessCapabilityApproved: ['harness:events:tool'],
    manifest: {
      id: 'a',
      name: 'a',
      version: '1.0.0',
      entry: 'main.js',
      schemaVersion: 3,
      kind: 'chip',
      harness: { events: ['tool'] },
      subscribe: { topics: ['turn'] },
    },
  } as InstalledGhost;
  let running = false;
  let wake!: () => void;
  const send = vi.fn();
  const gateway = new GhostSubscriptionGateway({
    listGhosts: () => [ghost],
    isRunning: () => running,
    wake: () =>
      new Promise<void>((resolve) => {
        wake = () => {
          running = true;
          resolve();
        };
      }),
    sendToGhost: send,
    now: () => 1,
  });
  return { ghost, gateway, send, wake: () => wake() };
}

describe('Harness bounded subscription delivery', () => {
  it('strips tool content from metadata-only subscribers', async () => {
    const f = fixture();
    f.gateway.publishHarness({ ...event, data: { ...event.data, content: { input: { secret: 'private' } } } }, () => true);
    f.wake();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0][1].data).not.toHaveProperty('content');
  });

  it('rechecks content permission before delivering a queued body', async () => {
    const f = fixture();
    f.ghost.manifest.harness!.read = ['tool-content'];
    f.ghost.harnessCapabilityApproved!.push('harness:read:tool-content');
    f.gateway.publishHarness({ ...event, data: { ...event.data, content: 'private' } }, () => true);
    f.ghost.harnessCapabilityApproved = ['harness:events:tool'];
    f.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not grant Harness events through a legacy subscription', () => {
    const f = fixture();
    f.ghost.harnessCapabilityApproved = undefined;
    f.gateway.publishHarness(event, () => true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rechecks revision and permission after waking before delivering buffered data', async () => {
    const f = fixture();
    f.gateway.publishHarness(event, () => true);
    f.ghost.approval = { state: 'approved', revision: '2' };
    f.wake();
    await vi.waitFor(() => expect(f.send).not.toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    f.gateway.publishHarness(event, () => true);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0][1]).toMatchObject({ type: 'harness-event', seq: 2, dropped: 1 });
  });

  it('drops a replaced session and a newly disabled workdir before delivery', async () => {
    const f = fixture();
    let current = true;
    f.gateway.publishHarness(event, () => current);
    current = false;
    f.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
    f.gateway.publishHarness(
      event,
      () => true,
      () => false,
    );
    expect(f.send).not.toHaveBeenCalled();
  });
});
