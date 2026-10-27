/** Cloud companions (docs/product-rules/cloud-companions.md): which computer runs each companion. */
export interface CompanionCloudHomeDevice {
  deviceId: string;
  /** Device-link name; empty when the device is not in this account's device list. */
  name: string;
  online: boolean;
  /** The device list says this computer allows remote control; absent when the list had no entry for it. */
  remoteControlEnabled?: boolean;
  isSelf: boolean;
}

/** What a move to this computer could not keep of the companion's old setup (cloud-companions.md §2). */
export type CompanionArrivalNoticeKind = 'permissions' | 'model';

export interface CompanionCloudActor {
  /** Chat Server actor id. */
  id: string;
  /** Local Bot profile id. */
  externalId: string;
  name: string;
  avatar: string | null;
  /** device-link deviceId of the companion's home computer; null when not registered yet. */
  homeDeviceId: string | null;
  /** Resolved home computer; only present in the renderer view (state IPC / change push). */
  homeDevice?: CompanionCloudHomeDevice | null;
  /** Only in the renderer view: shown once after the companion arrived here, then dismissed. */
  arrivalNotices?: CompanionArrivalNoticeKind[];
}

export interface CompanionCloudSnapshot {
  /** Server supports companion homes and this login carries a device id. */
  enabled: boolean;
  selfDeviceId: string | null;
  humanActorId: string | null;
  actors: CompanionCloudActor[];
  /** Local companions whose home moved to another computer: hidden, never run here. */
  demotedBotIds: string[];
}

export const EMPTY_COMPANION_CLOUD_SNAPSHOT: CompanionCloudSnapshot = Object.freeze({
  enabled: false,
  selfDeviceId: null,
  humanActorId: null,
  actors: [],
  demotedBotIds: [],
}) as CompanionCloudSnapshot;

export type CompanionCloudFailureCode =
  | 'HOME_CONFLICT' | 'OFFLINE' | 'NOT_ENABLED' | 'FAILED' | 'TARGET_UNAVAILABLE' | 'BUSY'
  /** The home runs a Cindy that cannot be asked from another computer; change it there. */
  | 'HOME_OUTDATED'
  /** The companion (one of the copies, for a merge) is paused: resume it first. */
  | 'PAUSED';

export type CompanionCloudActionResult =
  | { ok: true }
  | { ok: false; code: CompanionCloudFailureCode; homeDeviceId?: string | null };

/**
 * What a move does while the companion is still working (a turn running or queued in any of
 * its tasks): fail with `BUSY` (default), wait for it to finish, or stop it first.
 */
export interface CompanionSwitchOptions {
  whenBusy?: 'wait' | 'stop';
}

export interface CompanionTranscriptMessage {
  /** Chat Server message id. */
  id: string;
  seq: string;
  role: 'user' | 'assistant';
  text: string;
  /** Unix ms. */
  createdAt: number;
  /** Files sent with the message, stored with the room (open through the companion's room). */
  attachments?: Array<{ mediaId: string; name: string }>;
}

export interface CompanionTranscriptPage {
  /** Oldest first. */
  messages: CompanionTranscriptMessage[];
  /** Pass back as `before` for older messages; absent at the start of the room. */
  nextBefore?: string;
}

/** A copy of Cindy in the cloud (made from the Cindy preset), one of several to merge. */
export interface CompanionCindyCopy {
  botId: string;
  name: string;
  homeDeviceId: string | null;
}

export type CompanionMergeResult =
  | { ok: true; merged: number; messages: number; memories: number; skills: number; renamed: string[] }
  | { ok: false; code: CompanionCloudFailureCode };

export interface CompanionTransferTarget {
  deviceId: string;
  name: string;
  online: boolean;
  /** The computer asking (only in `CompanionHomeChoices`). */
  isSelf?: boolean;
}

/**
 * Where a companion can move, as seen from this computer (cloud-companions.md §3.1):
 * - `local`: this computer is the home and hands it over itself;
 * - `remote`: the home is another reachable computer, asked to hand it over;
 * - `takeOver`: the home cannot be reached; only this computer can continue it;
 * - `unavailable`: the home cannot be changed from here (`reason`).
 */
export interface CompanionHomeChoices {
  homeDeviceId: string | null;
  /** Device-link name of the home; empty when unknown here. */
  homeName?: string;
  mode: 'local' | 'remote' | 'takeOver' | 'unavailable';
  reason?: 'HOME_OUTDATED' | 'NOT_ENABLED' | 'NOT_FOUND';
  /** Computers it can move to (never the current home). */
  targets: CompanionTransferTarget[];
  /** Why this computer is not among the targets of a remote home: it has not allowed same-account control. */
  thisComputer?: 'REMOTE_CONTROL_OFF';
}
