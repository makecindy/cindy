import assert from 'node:assert/strict';
import { createInputQueue } from '../agent/input-queue.mjs';

// The failed snapshot belongs to a synthetic idle task. The first drain observes its
// rejected write, the second rebuilds from durable storage just as the clear scan does.
export function profileReleaseFixture(t) {
  let fail = true;
  const queue = createInputQueue({
    getMaker: () => ({ getSession: () => null, closeSession: async () => {} }),
    readSession: async id => ({ id, status: 'active', agentKind: 'codex', workingDir: '/', model: 'fixture' }),
    loadQueueSnapshot: async () => [],
    persistQueueSnapshot: async () => { if (fail) throw new Error('/private/fixture/queue.json'); },
    hub: { publish() {} },
  });
  t.after(() => { fail = false; return queue.dispose(); });
  return {
    queue,
    async occupy(message) {
      await assert.rejects(queue.enqueue('release-fixture', { clientId: 'pending', text: 'queued' }), /fixture\/queue/);
      queue.holdForDesktop(message);
    },
    async failRelease() {
      await assert.rejects(queue.releaseDesktopHold(), /Failed to drain task persistence/);
    },
    async recover() {
      fail = false;
      assert.equal(await queue.releaseDesktopHold(), true);
    },
  };
}
