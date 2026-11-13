import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotReadStateStorage } from '../../../../main/maker-ipc/botReadStateStorage';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { BotReadStateChanged, BotReadStateRequest } from '../../../../shared/botReadStateStorage';

/** Real Main serial merge + atomic files, shared by independent renderer projections in unit tests. */
export function botReadStateFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-read-projection-'));
  const listeners = new Set<(event: BotReadStateChanged) => void>();
  const dependencies = {
    currentOwner: getDataOwnerGeneration,
    boundaryPending: () => false,
    ownerRoot: () => path.join(root, encodeURIComponent(getDataOwnerGeneration().dataOwnerId ?? 'signed-out')),
    publish: (event: BotReadStateChanged) => listeners.forEach(fn => fn(event)),
  };
  let main = createBotReadStateStorage(dependencies);
  const pending = new Set<ReturnType<typeof main.access>>();
  return {
    bridge: {
      botReadState: (request: BotReadStateRequest) => {
        const reply = main.access(request);
        pending.add(reply);
        void reply.then(() => pending.delete(reply), () => pending.delete(reply));
        return reply;
      },
      onBotReadStateChanged: (fn: (event: BotReadStateChanged) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    },
    restart: () => { main = createBotReadStateStorage(dependencies); },
    publish: dependencies.publish,
    listenerCount: () => listeners.size,
    async settled() {
      do {
        await Promise.all([...pending]);
        // Let the renderer's resolved IPC continuations enqueue the next batch
        // before declaring the real Main/file fixture quiescent.
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (pending.size);
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
