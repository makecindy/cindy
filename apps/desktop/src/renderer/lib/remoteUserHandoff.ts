/** View-only send positions survive the DB echo until history owns the row. */
export interface LocalUserHandoff {
  clientId: string;
  role: string;
  localSendPrecedingClientIds?: readonly string[];
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
  const reservations = messages.filter((row) => row.role === 'user' && row.localSendPrecedingClientIds);
  // Place earlier sends first: the raw timestamp order may put a later send first.
  reservations.sort((a, b) => b.localSendPrecedingClientIds!.includes(a.clientId) ? -1
    : a.localSendPrecedingClientIds!.includes(b.clientId) ? 1 : 0);
  for (const row of reservations) {
    const preceding = new Set(row.localSendPrecedingClientIds);
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
    result.splice(after + 1, 0, row);
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
