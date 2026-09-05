export type SessionSnapshotResource =
  'messages' | 'pending-interactions' | 'input-projection';

export interface SessionSnapshotRequestIdentity {
  deviceId: string;
  sessionId: string;
  connectionEpoch: number;
  subscriptionIdentity?: number | null;
  signal?: AbortSignal;
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
  'deviceId' | 'sessionId' | 'connectionEpoch' | 'subscriptionIdentity' | 'signal'
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

interface SnapshotRead {
  promise: Promise<unknown>;
  cancel(): void;
}
/** Local invalidation, not a transport failure or a permanent missing resource. */
export class SnapshotReadSupersededError extends Error {
  constructor() {
    super('Remote sync superseded');
    this.name = 'SnapshotReadSupersededError';
  }
}
const inFlightSessionSnapshotRequests = new Map<string, SnapshotRead>();

function requestKey(identity: SessionSnapshotRequestIdentity): string {
  return JSON.stringify([
    identity.deviceId,
    identity.sessionId,
    identity.connectionEpoch,
    identity.subscriptionIdentity ?? null,
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
  if (identity.signal?.aborted) return Promise.reject(new SnapshotReadSupersededError());
  const key = requestKey(identity);
  const current = inFlightSessionSnapshotRequests.get(key);
  if (current) {
    invalidateOnCancellation(key, current, identity.signal);
    return current.promise as Promise<T>;
  }

  let request: Promise<T>;
  try {
    request = read();
  } catch (error) {
    request = Promise.reject(error);
  }
  let cancel!: () => void;
  const shared = new Promise<T>((resolve, reject) => {
    cancel = () => reject(new SnapshotReadSupersededError());
    // Always observe the physical response, including rejection after cancellation.
    void request.then(resolve, reject);
  });
  const entry: SnapshotRead = { promise: shared, cancel };
  inFlightSessionSnapshotRequests.set(key, entry);
  invalidateOnCancellation(key, entry, identity.signal);
  const clear = () => {
    if (inFlightSessionSnapshotRequests.get(key) === entry) {
      inFlightSessionSnapshotRequests.delete(key);
    }
  };
  void shared.then(clear, clear);
  return shared;
}

/** Cancelled callers must not lend a pre-recovery physical response to a newer run. */
function invalidateOnCancellation(key: string, entry: SnapshotRead, signal?: AbortSignal): void {
  if (!signal) return;
  const invalidate = () => {
    if (inFlightSessionSnapshotRequests.get(key) === entry) inFlightSessionSnapshotRequests.delete(key);
    // All consumers of this exact stale response lose commit eligibility, including
    // a rehydrate caller sharing it with the detail page. Rehydrate classifies this
    // local invalidation as needing a fresh snapshot. Other peers are untouched.
    entry.cancel();
  };
  signal.addEventListener('abort', invalidate, { once: true });
  const clear = () => signal.removeEventListener('abort', invalidate);
  void entry.promise.then(clear, clear);
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

/** The visible message window never waits for unrelated control-state snapshots. */
export async function readProgressiveMessageWindow<Metadata, History>(options: {
  readMetadata(): Promise<Metadata>;
  readMessages(): Promise<History>;
  eager: boolean;
  shouldReadMessages(metadata: Metadata): boolean;
  isCurrent(): boolean;
  commitMessages(history: History): void;
}): Promise<{ metadata: Metadata; history: History | null }> {
  const messages = () => runConnectionScopedSessionMetadataRead(
    options.readMessages, options.isCurrent, options.commitMessages,
  );
  const metadata = options.readMetadata();
  const history = options.eager
    ? messages()
    : metadata.then((value) => options.isCurrent() && options.shouldReadMessages(value) ? messages() : null);
  const [metadataValue, historyValue] = await Promise.all([metadata, history]);
  return { metadata: metadataValue, history: historyValue };
}

/** Apply each successful response immediately while retaining allSettled failure classification. */
export async function settleProgressiveSnapshot<T>(
  read: Promise<T>,
  commit: (value: T) => void,
): Promise<PromiseSettledResult<T>> {
  try {
    const value = await read;
    commit(value);
    return { status: 'fulfilled', value };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
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
