import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';

// File preparation, queued reads and capability probes precede a connection ID.
// Keep their cancellation boundary aligned with established file connections.
const peers = new Map<string, symbol>();
export function captureFilePeerScope(peer: string): () => boolean {
  const owner = captureDataOwnerBroadcastScope();
  let token = peers.get(peer);
  if (!token) peers.set(peer, (token = Symbol()));
  return () => peers.get(peer) === token && isDataOwnerBroadcastScopeCurrent(owner);
}
export function invalidateFilePeerScopes(peer?: string): void {
  if (peer) peers.delete(peer);
  else peers.clear();
}
