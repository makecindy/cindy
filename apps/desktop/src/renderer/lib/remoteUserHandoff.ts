/** View-only send positions survive the DB echo until history owns the row. */
export interface LocalUserHandoff {
  clientId: string;
  role: string;
  systemCardType?: string;
  isPendingPersist?: boolean;
  localSendPrecedingClientIds?: readonly string[];
  isLocalSystemCard?: boolean;
}

export function reserveRemoteUser<T extends LocalUserHandoff>(row: T, preceding: readonly T[]): T {
  return { ...row, localSendPrecedingClientIds: preceding.map((message) => message.clientId) };
}

/** Device clocks are not evidence of which turn the user sent into. */
export function projectRemoteUsers<T extends LocalUserHandoff>(
  messages: readonly T[],
  historyClientIds: ReadonlySet<string> = new Set(),
): T[] {
  // Authoritative history is rendered before its live tail, even if raw timestamps
  // put a new reply ahead of the late first page. This boundary still applies
  // after history confirms the last local user and retires its reservation.
  const historical = (row: T) => historyClientIds.has(row.clientId) && !row.localSendPrecedingClientIds;
  const result = [...messages.filter(historical), ...messages.filter((row) => !historical(row))];
  const reservations = messages.filter((row) => row.role === 'user'
    && (row.localSendPrecedingClientIds || row.isPendingPersist)).map((row) => ({
      row,
      // Local sends retain insertion order until their echo creates a reservation.
      preceding: new Set(row.localSendPrecedingClientIds
        ?? messages.slice(0, messages.indexOf(row)).map((message) => message.clientId)),
    }));
  // Place earlier sends first: the raw timestamp order may put a later send first.
  reservations.sort((a, b) => b.preceding.has(a.row.clientId) ? -1
    : a.preceding.has(b.row.clientId) ? 1 : 0);
  for (let index = 0; index < reservations.length; index++) {
    const { row, preceding } = reservations[index];
    const nextSend = reservations[index + 1];
    result.splice(
      result.findIndex((message) => message.clientId === row.clientId),
      1,
    );
    let after = -1;
    for (let index = 0; index < result.length; index++) {
      // A partial cold cache may have supplied an anchor before newer history
      // arrived. The whole authoritative prefix is still before this local send.
      if (preceding.has(result[index].clientId) || historical(result[index])) after = index;
    }
    // Switching is applied after enqueue but before this send. Its boundary
    // belongs before the reserved bubble; never cross ordinary turn activity.
    // A boundary not observed by the next send belongs to that later send,
    // even when this row already has a DB echo and no reply has arrived yet.
    while (result[after + 1]?.systemCardType === 'agent-switch'
      && (!nextSend || nextSend.preceding.has(result[after + 1].clientId))) after++;
    result.splice(after + 1, 0, row);
  }
  // Command cards never acquire a history row. Keep their slots even after a
  // later user send becomes historical and moves into the authoritative prefix.
  let beforeClientId: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index];
    if (row.isLocalSystemCard) {
      result.splice(result.findIndex((message) => message.clientId === row.clientId), 1);
      const before = beforeClientId === undefined ? -1
        : result.findIndex((message) => message.clientId === beforeClientId);
      result.splice(before < 0 ? result.length : before, 0, row);
    }
    beforeClientId = row.clientId;
  }
  return result;
}

/** Retire once, so later rewind/deletion cannot revive a local reservation. */
export function confirmRemoteUsers<T extends LocalUserHandoff>(
  messages: T[],
  confirmed: ReadonlySet<string>,
): T[] {
  let changed = false;
  const next = messages.map((row) => {
    if (!row.localSendPrecedingClientIds || !confirmed.has(row.clientId)) return row;
    const { localSendPrecedingClientIds: _position, ...message } = row;
    changed = true;
    return message as T;
  });
  return changed ? next : messages;
}
