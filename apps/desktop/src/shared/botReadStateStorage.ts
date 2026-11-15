/** Local Desktop read positions only; never part of Device Link or the server unread contract. */
export type BotReadIdentity =
  | { kind: 'bot' | 'group' | 'thread'; id: string }
  | { kind: 'remote-bot'; deviceId: string; botId: string };

export interface BotReadOwner {
  dataOwnerId: string;
  generation: number;
}

/** An automatic discovery is not evidence that the user actually read a message. */
export interface BotReadPosition {
  identity: BotReadIdentity;
  initialAt?: number;
  ackAt?: number;
  /** Unlabelled legacy positions preserve their old display without becoming explicit acknowledgements. */
  legacyFloor?: number;
}

export interface BotReadStateVersion {
  owner: BotReadOwner;
  instanceId: string;
  revision: number;
}

/** Events invalidate a projection; they do not pretend to contain an updated snapshot. */
export type BotReadStateChanged = BotReadStateVersion;

export type BotReadStateRequest = { owner: BotReadOwner } & (
  | { action: 'snapshot'; cursor?: string }
  | { action: 'merge'; positions: BotReadPosition[] }
);

export type BotReadStateResult = BotReadStateVersion & {
  positions: BotReadPosition[];
  /** Only snapshot results may be paginated. A stale cursor must restart the snapshot. */
  nextCursor?: string;
};

/** The tuple encoding avoids collisions between local keys and (device, bot) identities. */
export function botReadIdentityKey(identity: BotReadIdentity): string {
  return identity.kind === 'remote-bot'
    ? JSON.stringify([identity.kind, identity.deviceId, identity.botId])
    : JSON.stringify([identity.kind, identity.id]);
}

export function effectiveBotReadAt(position: BotReadPosition): number | undefined {
  if (position.ackAt !== undefined || position.legacyFloor !== undefined) {
    return Math.max(position.ackAt ?? 0, position.legacyFloor ?? 0);
  }
  return position.initialAt;
}
