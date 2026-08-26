import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { consumeForgePackForPublish } from '../forgePackPublishConsume.js';
import { createForgePackStagingController, FORGE_PACK_TICKET_TTL_MS } from '../forgePackStaging.js';

const roots: string[] = [];
const owner = { mode: 'cloud' as const, dataOwnerId: 'member-1', generation: 7 };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(nowValue = 1_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-publish-consume-'));
  roots.push(root);
  let now = nowValue;
  const controller = createForgePackStagingController({
    getTempDir: () => root,
    now: () => now,
    ttlMs: FORGE_PACK_TICKET_TTL_MS,
    randomId: (() => {
      let sequence = 0;
      return () => `token-${++sequence}`;
    })(),
    scheduleTimeout: () => ({ cancel() {} }),
  });
  const staged = controller.stage({
    buf: Buffer.from('packed bytes'),
    manifestId: 'acme-demo',
    owner,
    operationKind: 'install',
  });
  return { controller, staged, setNow: (value: number) => (now = value) };
}

describe('consumeForgePackForPublish', () => {
  it('checks the session boundary before consuming the one-shot ticket', () => {
    const { controller, staged } = harness();
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner: owner,
        boundaryPending: true,
      }),
    ).toEqual({ kind: 'rejected', reason: 'session-boundary-pending' });
    // Excludes the wrong order "consume then check boundary": the same ticket remains usable.
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner: owner,
        boundaryPending: false,
      }).kind,
    ).toBe('accepted');
  });

  it.each([
    { field: 'mode', currentOwner: { ...owner, mode: 'local' as const } },
    { field: 'dataOwnerId', currentOwner: { ...owner, dataOwnerId: 'member-2' } },
    { field: 'generation', currentOwner: { ...owner, generation: owner.generation + 1 } },
  ])('rejects $field owner mismatch and deletes staging bytes', ({ currentOwner }) => {
    const { controller, staged } = harness();
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    expect(fs.existsSync(staged.stagingPath)).toBe(false);
  });

  it('rejects replay after one accepted consume', () => {
    const { controller, staged } = harness();
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner: owner,
        boundaryPending: false,
      }).kind,
    ).toBe('accepted');
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner: owner,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'ticket-invalid' });
  });

  it('rejects the pack ticket at its own 10-minute expiry', () => {
    const { controller, staged, setNow } = harness();
    setNow(1_000 + FORGE_PACK_TICKET_TTL_MS);
    expect(
      consumeForgePackForPublish(controller, {
        token: staged.ticket,
        currentOwner: owner,
        boundaryPending: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'ticket-invalid' });
    expect(fs.existsSync(staged.stagingPath)).toBe(false);
  });
});
