/** Optional payload extension of maker:input:get-projection; old hosts omit it. */
export type InputDeliveryState = "pending" | "accepted" | "removed" | "unknown";
export interface InputDeliveryReceipt {
  clientId: string;
  state: InputDeliveryState;
}
export interface InputDeliveryProjection {
  inputDeliveryVersion?: 1;
  deliveryReceipts?: InputDeliveryReceipt[];
  /** Present only for a requested input the active engine has started. */
  dispatchedInput?: { clientId: string; agentKind: string };
}

export function projectionContainsInput(projection: InputDeliveryProjection & {
  pendingQueue: readonly { clientId: string }[];
  steeringQueueClientIds?: readonly string[];
  queueSnapshot?: { dispatchClientId?: string | null; pendingSteerClientIds?: readonly string[] };
  withdrawnQueueClientIds?: readonly string[];
  continuationTurnClientId?: string | null;
  continuationInFlightClientId?: string | null;
  recovery?: unknown;
}, clientId: string): boolean {
  const recovery = projection.recovery as { clientId?: string; item?: { clientId?: string } } | null | undefined;
  return Boolean(projection.pendingQueue.some((item) => item.clientId === clientId)
    || projection.steeringQueueClientIds?.includes(clientId)
    || projection.queueSnapshot?.pendingSteerClientIds?.includes(clientId)
    || projection.queueSnapshot?.dispatchClientId === clientId
    || projection.dispatchedInput?.clientId === clientId
    || projection.continuationTurnClientId === clientId
    || projection.continuationInFlightClientId === clientId
    || recovery?.clientId === clientId || recovery?.item?.clientId === clientId
    || projection.withdrawnQueueClientIds?.includes(clientId)
    || projection.deliveryReceipts?.some((receipt) => receipt.clientId === clientId && receipt.state !== 'unknown'));
}

/** Classify only refusals known to precede input acceptance. */
export function remoteInputRefusal(message: string):
  'taskInactive' | 'profileInUseByDesktop' | 'inputNotSupported' | 'invalidInput' | 'taskClearedBeforeSend' | 'other' | undefined {
  if (message === 'session is not active' || message === '[PRECONDITION_FAILED] Session is not active') return 'taskInactive';
  if (message.startsWith('[PRECONDITION_FAILED] HOST_PROFILE_IN_USE_BY_DESKTOP:')) return 'profileInUseByDesktop';
  if (message.startsWith('[UNSUPPORTED_CAPABILITY] ')) return 'inputNotSupported';
  if (message.startsWith('[INVALID_PARAMS] ')) return 'invalidInput';
  if (message.startsWith('[PRECONDITION_FAILED] REMOTE_OPTIMISTIC_INPUT_CLEARED:')) return 'taskClearedBeforeSend';
  // A dispatcher's generic NOT_FOUND can follow a write; only the task preflight includes this ID.
  if (/^\[NOT_FOUND\] Session \S+ not found$/.test(message)
      || /^\[(?:CHANNEL_NOT_ALLOWED|REMOTE_DISABLED)\] /.test(message)
      || /^\[PRECONDITION_FAILED\] (?:REMOTE_OPTIMISTIC_INPUT_SUPERSEDED:|Account changed before input$|binary_not_ready:)/.test(message)) return 'other';
  return undefined;
}

/** Bound work before querying durable delivery state. No message content is returned. */
export function readInputDeliveryClientIds(
  options: unknown,
): string[] | undefined {
  if (
    !options ||
    typeof options !== "object" ||
    !("deliveryClientIds" in options)
  )
    return undefined;
  const ids = (options as { deliveryClientIds?: unknown }).deliveryClientIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 64 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  ) {
    throw new Error(
      "deliveryClientIds must contain at most 64 nonempty IDs (256 characters each)",
    );
  }
  return [...new Set(ids as string[])];
}
