import { runGhostSnapshotWorkerRequest, type GhostSnapshotWorkerRequest } from './store/ghostSnapshotWorkerProcess.js';

let handled = false;
process.on('disconnect', () => process.exit(0));
process.on('message', (message: unknown) => {
  if (handled || !message || typeof message !== 'object') return;
  const value = message as { type?: unknown; request?: GhostSnapshotWorkerRequest };
  if (value.type !== 'mutate' || !value.request) return;
  handled = true;
  void runGhostSnapshotWorkerRequest(value.request).then(
    () => process.send?.({ ok: true }),
    error => process.send?.({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
});
process.send?.({ type: 'ready' });
