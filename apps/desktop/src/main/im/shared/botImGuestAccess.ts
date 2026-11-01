/**
 * main/im/shared/botImGuestAccess.ts
 * ---------------------------------------------------------------------------
 * Guest isolation for teammate-owned IM connections (#8359).
 *
 * A guest private chat runs in the teammate's `channel` lane keyed
 * `im:<channel>:<botContextId>:dm:<userId>`. The user id in that key comes from
 * the transport (verified by Main), never from model output, so it is the only
 * input used here. The owner binds a guest to one linked project; the binding
 * decides the lane's working directory and memory scope before any turn runs.
 *
 * Fail closed: a binding whose project is no longer linked or no longer exists
 * refuses the turn rather than falling back to the teammate's shared Home.
 */

import { stat } from 'node:fs/promises';

import { buildBotGuestMemoryScopeKey } from '@cindy/maker-core';

import type { BotImConnectionRecord, BotImUnboundGuestPolicy } from '../../../shared/botImConnection.js';

export interface GuestDmRoute {
  channel: string;
  botContextId: string;
  guestId: string;
}

/** Inverse of `companionLaneRouteKey` for the `guest-dm` lane only. */
export function parseGuestDmRouteKey(routeKey: string | null | undefined): GuestDmRoute | null {
  if (!routeKey) return null;
  const match = /^im:([a-z]+):(.+):dm:([^:]+)$/.exec(routeKey);
  if (!match) return null;
  const [, channel, botContextId, guestId] = match;
  // A group key never contains `:dm:`; a botContextId never ends with a group marker.
  if (/:g:/.test(`:${botContextId}:`)) return null;
  return { channel, botContextId, guestId };
}

export type GuestLaneAccess =
  /** Not a guest lane, or the guest uses the teammate's shared workspace. */
  | { kind: 'shared' }
  /** The guest has its own project and memory. */
  | { kind: 'bound'; route: GuestDmRoute; projectPath: string; memoryScopeKey: string }
  /** No turn may run for this guest. */
  | { kind: 'refused'; route: GuestDmRoute; reason: 'unbound' | 'project-unavailable' };

export interface GuestLaneAccessDeps {
  listConnections(botId: string): readonly BotImConnectionRecord[];
  /** Absolute paths of the local projects linked to this teammate. */
  readLinkedProjectPaths(botId: string): Promise<readonly string[]>;
  isDirectory?(dir: string): Promise<boolean>;
  /** Platform-aware path identity (case-insensitive on Windows / macOS). */
  sameDirectory(left: string, right: string): boolean;
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((value) => value.isDirectory(), () => false);
}

export function findGuestConnection(
  connections: readonly BotImConnectionRecord[],
  route: GuestDmRoute,
): BotImConnectionRecord | null {
  return connections.find(
    (record) => record.channel === route.channel && record.botContextId === route.botContextId,
  ) ?? null;
}

export async function resolveGuestLaneAccess(
  botId: string,
  routeKey: string | null | undefined,
  deps: GuestLaneAccessDeps,
): Promise<GuestLaneAccess> {
  const route = parseGuestDmRouteKey(routeKey);
  if (!route) return { kind: 'shared' };
  const connection = findGuestConnection(deps.listConnections(botId), route);
  const access = connection?.guestAccess;
  const binding = access?.bindings && Object.hasOwn(access.bindings, route.guestId)
    ? access.bindings[route.guestId]
    : undefined;
  if (!binding) {
    const policy: BotImUnboundGuestPolicy = access?.unbound ?? 'shared';
    return policy === 'refuse' ? { kind: 'refused', route, reason: 'unbound' } : { kind: 'shared' };
  }
  const linked = await deps.readLinkedProjectPaths(botId);
  const isDirectory = deps.isDirectory ?? isExistingDirectory;
  if (!linked.some((dir) => deps.sameDirectory(dir, binding.projectPath))
    || !(await isDirectory(binding.projectPath))) {
    return { kind: 'refused', route, reason: 'project-unavailable' };
  }
  return {
    kind: 'bound',
    route,
    projectPath: binding.projectPath,
    memoryScopeKey: buildBotGuestMemoryScopeKey(botId, route.channel, route.guestId),
  };
}

/** Thrown when a refused guest lane is about to start a runtime. */
export class BotGuestAccessRefusedError extends Error {
  readonly code = 'BOT_GUEST_ACCESS_REFUSED';
  constructor(readonly reason: 'unbound' | 'project-unavailable') {
    super(`Guest access refused (${reason})`);
    this.name = 'BotGuestAccessRefusedError';
  }
}
