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

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { buildBotGuestMemoryScopeKey } from '@cindy/maker-core';

import {
  BOT_IM_CHANNELS,
  type BotImConnectionRecord,
  type BotImUnboundGuestPolicy,
} from '../../../shared/botImConnection.js';

export interface GuestDmRoute {
  channel: string;
  botContextId: string;
  guestId: string;
}

/**
 * Cheap pre-check: could this be a guest private-chat lane? Exact parsing needs
 * the connection list (`matchGuestDmRoute`), because platform user ids may
 * themselves contain `:`.
 */
export function parseGuestDmRouteKey(routeKey: string | null | undefined): boolean {
  return !!routeKey && routeKey.startsWith('im:') && routeKey.includes(':dm:');
}

/** Match a lane key against the bot's connections by their exact prefix. */
export function matchGuestDmRoute(
  connections: readonly BotImConnectionRecord[],
  routeKey: string,
): { connection: BotImConnectionRecord; route: GuestDmRoute } | null {
  for (const connection of connections) {
    if (!connection.botContextId) continue;
    const prefix = `im:${connection.channel}:${connection.botContextId}:dm:`;
    if (!routeKey.startsWith(prefix)) continue;
    const guestId = routeKey.slice(prefix.length);
    if (!guestId) continue;
    return { connection, route: { channel: connection.channel, botContextId: connection.botContextId, guestId } };
  }
  return null;
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
  /** Cindy's own data directories; a project overlapping one is refused. */
  protectedDirs?(): readonly string[];
}

/** Resolve links and junctions of the longest existing prefix. */
async function realPathOf(candidate: string): Promise<string> {
  let current = candidate;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A guest project must neither contain nor sit inside Cindy's own data (every
 * Bot Home and every other guest's memory live there). Both the written paths
 * and their real paths are compared, so a symlink or a Windows junction cannot
 * hide the overlap.
 */
export async function overlapsProtectedDir(projectPath: string, protectedDirs: readonly string[]): Promise<boolean> {
  const project = path.resolve(projectPath);
  const realProject = await realPathOf(project);
  for (const dir of protectedDirs) {
    const written = path.resolve(dir);
    const real = await realPathOf(written);
    for (const [left, right] of [[project, written], [realProject, real]] as const) {
      if (isWithin(left, right) || isWithin(right, left)) return true;
    }
  }
  return false;
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((value) => value.isDirectory(), () => false);
}

export async function resolveGuestLaneAccess(
  botId: string,
  routeKey: string | null | undefined,
  deps: GuestLaneAccessDeps,
): Promise<GuestLaneAccess> {
  if (!routeKey || !parseGuestDmRouteKey(routeKey)) return { kind: 'shared' };
  const matched = matchGuestDmRoute(deps.listConnections(botId), routeKey);
  // A guest lane that matches none of the bot's connections (removed, or a key
  // we cannot read) fails closed instead of getting the shared Home.
  if (!matched) {
    // Channels without connection records (personal WeChat …) keep their own
    // routing; isolation applies to teammate-owned connections only.
    const channel = routeKey.slice('im:'.length).split(':', 1)[0];
    if (!(BOT_IM_CHANNELS as readonly string[]).includes(channel)) return { kind: 'shared' };
    return { kind: 'refused', route: { channel: '', botContextId: '', guestId: '' }, reason: 'unbound' };
  }
  const { connection, route } = matched;
  const access = connection.guestAccess;
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
    || !(await isDirectory(binding.projectPath))
    // Re-checked on every start: a link can be retargeted after binding.
    || (deps.protectedDirs && await overlapsProtectedDir(binding.projectPath, deps.protectedDirs()))) {
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
