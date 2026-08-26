export type SessionSnapshotResource =
  'messages' | 'pending-interactions' | 'input-projection';

export interface SessionSnapshotRequestIdentity {
  deviceId: string;
  sessionId: string;
  connectionEpoch: number;
  resource: SessionSnapshotResource;
  /**
   * Exact request semantics and local authority fence. Requests only share a
   * physical invoke when this value also matches, so a different history
   * window or a snapshot started before a newer local push never gets reused.
   */
  variant: string;
}

export type SessionSnapshotScope = Pick<
  SessionSnapshotRequestIdentity,
  'deviceId' | 'sessionId' | 'connectionEpoch'
>;

export type SessionMessageSnapshotFence =
  | { kind: 'detail'; generation: number }
  | { kind: 'unentered'; generation: number; resetEpoch: number };

export function sessionMessagesSnapshotVariant(
  limit: number,
  fence: SessionMessageSnapshotFence,
): string {
  return fence.kind === 'detail'
    ? `limit=${limit};authority=detail:${fence.generation}`
    : `limit=${limit};authority=unentered:${fence.generation}:${fence.resetEpoch}`;
}

export function sessionProjectionSnapshotVariant(
  authorityEpoch: number,
): string {
  return `authority=${authorityEpoch}`;
}

const snapshotReferenceIds = new WeakMap<object, number>();
let nextSnapshotReferenceId = 0;

/**
 * Pending interactions do not expose an authority counter. The store keeps a
 * stable array reference until its visible snapshot changes, so object identity
 * is an exact in-process freshness fence without putting card contents in keys
 * or logs. WeakMap entries disappear with the old snapshot.
 */
export function sessionPendingInteractionsSnapshotVariant(
  snapshot: readonly unknown[],
): string {
  let id = snapshotReferenceIds.get(snapshot);
  if (id === undefined) {
    id = ++nextSnapshotReferenceId;
    snapshotReferenceIds.set(snapshot, id);
  }
  return `snapshot=${id}`;
}

const inFlightSessionSnapshotRequests = new Map<string, Promise<unknown>>();

function requestKey(identity: SessionSnapshotRequestIdentity): string {
  return JSON.stringify([
    identity.deviceId,
    identity.sessionId,
    identity.connectionEpoch,
    identity.resource,
    identity.variant,
  ]);
}

/**
 * Shares only an identical in-flight read. Results are not cached: once the
 * request settles, a later caller performs a fresh authoritative read.
 */
export function runSessionSnapshotSingleFlight<T>(
  identity: SessionSnapshotRequestIdentity,
  read: () => Promise<T>,
): Promise<T> {
  const key = requestKey(identity);
  const current = inFlightSessionSnapshotRequests.get(key);
  if (current) return current as Promise<T>;

  let request: Promise<T>;
  try {
    request = read();
  } catch (error) {
    request = Promise.reject(error);
  }
  inFlightSessionSnapshotRequests.set(key, request);
  const clear = () => {
    if (inFlightSessionSnapshotRequests.get(key) === request) {
      inFlightSessionSnapshotRequests.delete(key);
    }
  };
  void request.then(clear, clear);
  return request;
}

export function runSessionMessagesSnapshotSingleFlight<T>(
  scope: SessionSnapshotScope,
  limit: number,
  fence: SessionMessageSnapshotFence,
  read: () => Promise<T>,
): Promise<T> {
  return runSessionSnapshotSingleFlight(
    {
      ...scope,
      resource: 'messages',
      variant: sessionMessagesSnapshotVariant(limit, fence),
    },
    read,
  );
}

export function runSessionPendingInteractionsSnapshotSingleFlight<T>(
  scope: SessionSnapshotScope,
  snapshot: readonly unknown[],
  read: () => Promise<T>,
): Promise<T> {
  return runSessionSnapshotSingleFlight(
    {
      ...scope,
      resource: 'pending-interactions',
      variant: sessionPendingInteractionsSnapshotVariant(snapshot),
    },
    read,
  );
}

export function runSessionProjectionSnapshotSingleFlight<T>(
  scope: SessionSnapshotScope,
  authorityEpoch: number,
  read: () => Promise<T>,
): Promise<T> {
  return runSessionSnapshotSingleFlight(
    {
      ...scope,
      resource: 'input-projection',
      variant: sessionProjectionSnapshotVariant(authorityEpoch),
    },
    read,
  );
}

type AsyncRead = () => Promise<unknown>;
type ReadResults<Reads extends readonly AsyncRead[]> = {
  [Index in keyof Reads]: Awaited<ReturnType<Reads[Index]>>;
};

/**
 * Publishes authoritative session metadata as soon as that read succeeds,
 * independently from sibling snapshots in the same opening batch.
 */
export async function runConnectionScopedSessionMetadataRead<T>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
  commit: (value: T) => void,
): Promise<T> {
  const value = await read();
  if (isCurrent()) commit(value);
  return value;
}

/**
 * Applies retry to each read independently. One timeout therefore retries only
 * that item instead of replaying every sibling request in the opening batch.
 */
export function runIndependentSnapshotReads<Reads extends readonly AsyncRead[]>(
  reads: Reads,
  retry: <T>(read: () => Promise<T>) => Promise<T>,
): Promise<ReadResults<Reads>> {
  return Promise.all(reads.map((read) => retry(read))) as Promise<
    ReadResults<Reads>
  >;
}
