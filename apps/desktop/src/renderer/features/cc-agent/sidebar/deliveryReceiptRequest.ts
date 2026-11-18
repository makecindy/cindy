type DeliveryReceiptListener = (sessionId: string) => void;

const listeners = new Set<DeliveryReceiptListener>();

/** Ask the single receipt host to open this task. Safe to call before the host mounts. */
let pendingSessionId: string | null = null;

export function requestOpenDeliveryReceipt(sessionId: string): void {
  if (!sessionId) return;
  pendingSessionId = sessionId;
  for (const listener of listeners) listener(sessionId);
}

export function takePendingDeliveryReceipt(): string | null {
  const sessionId = pendingSessionId;
  pendingSessionId = null;
  return sessionId;
}

export function subscribeDeliveryReceiptRequest(listener: DeliveryReceiptListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
