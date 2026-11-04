/**
 * Host-neutral MakerMemoryManager wiring.
 *
 * The manager itself already takes every host fact as a port; this module fixes
 * the composition those ports imply (owner-scoped root, scope key with the
 * boundary bit, enabled re-read on root change, Bot storage override) so the
 * Desktop process and the Node host cannot drift apart.
 */

import * as path from 'node:path';

import { MakerMemoryManager, type MakerMemoryManagerDeps, type SqliteFactory } from './manager.js';
import { parseBotMemoryScopeKey } from './storage.js';
import type { AgentKind } from '../types/common.js';
import type { Logger } from '../interfaces/logger.js';
import type { BaseAgent } from '../agents/base-agent.js';

export interface MemoryHostSession {
  /** Opaque owner id, or null while signed out / not settled. */
  dataOwnerId: string | null;
  /** Increments on every owner commit so caches can be dropped. */
  generation: number;
  mode: string;
  /** True while an owner transition is in flight; must fail closed. */
  boundaryPending: boolean;
}

export interface MakerMemoryHostContext {
  userDataDir: string;
  /** Read the live app session; Desktop passes its process state, the host its own. */
  readSession(): MemoryHostSession;
  /** Sanitized owner segment (Desktop: sha256 prefix); opaque to this module. */
  ownerSegment(ownerId: string): string;
  /** Read the persisted Maker Memory toggle for an owner root (null = unresolved). */
  readEnabled(ownerRoot: string | null): boolean;
  sqliteFactory: SqliteFactory;
  logger: Logger;
  /** Bot scopes keep their records inside the Bot Home. */
  botMemoryDir?(ownerRoot: string, botId: string): string;
  isOneShotRouteDisabled?(agent: AgentKind): Promise<boolean>;
  reviewOneShot?: MakerMemoryManagerDeps['reviewOneShot'];
  reviewAgent?: AgentKind;
}

/**
 * Build the owner-scoped memory manager. `agents` starts empty by design: the
 * assembly attaches them once the agent graph exists.
 */
export function createMakerMemoryManagerForHost(ctx: MakerMemoryHostContext): MakerMemoryManager {
  const resolveOwnerRoot = (): string | null => {
    const session = ctx.readSession();
    // A boundary in flight still reports the previous owner; writing there would
    // land in the account being replaced.
    if (session.boundaryPending || !session.dataOwnerId) return null;
    return path.join(ctx.userDataDir, 'owners', ctx.ownerSegment(session.dataOwnerId));
  };

  const ownerScopeKey = (): string => {
    const session = ctx.readSession();
    const segment = session.dataOwnerId ? ctx.ownerSegment(session.dataOwnerId) : 'none';
    const boundary = session.boundaryPending ? ':boundary' : '';
    return `${session.mode}:${segment}:${session.generation}${boundary}`;
  };

  const initialRoot = resolveOwnerRoot();
  const manager = new MakerMemoryManager({
    basePath: initialRoot ?? ctx.userDataDir,
    resolveBasePath: resolveOwnerRoot,
    ownerScopeKey,
    reloadEnabled: () => ctx.readEnabled(resolveOwnerRoot()),
    ...(ctx.botMemoryDir
      ? {
          resolveStorageDir: (scopeKey: string, ownerRoot: string) => {
            const botId = parseBotMemoryScopeKey(scopeKey);
            return botId ? ctx.botMemoryDir!(ownerRoot, botId) : null;
          },
          isIndependentScope: (scopeKey: string) => parseBotMemoryScopeKey(scopeKey) !== null,
        }
      : {}),
    sqliteFactory: ctx.sqliteFactory,
    agents: {},
    logger: ctx.logger,
    initialEnabled: ctx.readEnabled(initialRoot),
    ...(ctx.reviewAgent ? { reviewAgent: ctx.reviewAgent } : {}),
    ...(ctx.isOneShotRouteDisabled ? { isOneShotRouteDisabled: ctx.isOneShotRouteDisabled } : {}),
    ...(ctx.reviewOneShot ? { reviewOneShot: ctx.reviewOneShot } : {}),
  });
  return manager;
}

/** Attach the agent graph once it exists; the setter is bootstrap-only. */
export function attachAgentsToMakerMemory(
  manager: MakerMemoryManager,
  agents: Partial<Record<AgentKind, BaseAgent>>,
): void {
  manager.setAgents(agents);
}
