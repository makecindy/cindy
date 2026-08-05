/**
 * Host adapter for automatic Git snapshots.
 *
 * This file wires the pure GitSnapshotCoordinator to desktop main-process
 * dependencies: maker session metadata, repo detection, local message lookup,
 * worktree dirty checks, and oneShot label generation.
 */

import type { AgentKind, Maker } from '@cindy/maker-core';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { createSnapshot, createSnapshotMarker } from '../git-snapshot/gitSnapshotService.js';
import { extractUserPromptText } from '../git-snapshot/userPromptText.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { detectCwd } from '../worktree/WorktreeManager.js';
import { isWorktreeDirty } from '../worktree/dirty.js';
import { readGitSafetySettings } from './git-safety-settings-store.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';

const log = createLogger('git-snapshot');
const ONESHOT_MAX_TOKENS = 80;
const ONESHOT_TIMEOUT_MS = 20_000;

interface LatestUserMessage {
  clientId: string;
  text: string;
}

/** Optional dependency overrides used by focused main-process unit tests. */
export interface GitSnapshotCoordinatorHostDeps {
  readAutoSnapshotEnabled?: () => boolean;
  detectRepoRoot?: (workingDir: string) => Promise<string | null>;
  initializeProjectGit?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]['initializeProjectGit'];
  isWorktreeDirty?: (repoRoot: string) => Promise<boolean>;
  getLatestUserMessage?: (sessionId: string) => Promise<LatestUserMessage | null>;
  createSnapshot?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]['createSnapshot'];
  createSnapshotMarker?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]['createSnapshotMarker'];
  logger?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]['logger'];
}

type MakerForGitSnapshot = Pick<Maker, 'getSessionMeta' | 'oneShot'>;

async function defaultDetectRepoRoot(workingDir: string): Promise<string | null> {
  const info = await detectCwd(workingDir);
  if (!info.gitInstalled || !info.isGitRepo || !info.repoRoot || info.isInsideWorktree) {
    return null;
  }
  return info.repoRoot;
}

async function defaultGetLatestUserMessage(sessionId: string): Promise<LatestUserMessage | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ clientId: messages.clientId, content: messages.content })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      isNull(messages.rewindAt),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (!row) return null;
  return { clientId: row.clientId, text: extractUserPromptText(row.content) };
}

/**
 * Constructs the automatic snapshot coordinator from real desktop host deps.
 */
export function createGitSnapshotCoordinator(
  maker: MakerForGitSnapshot,
  deps: GitSnapshotCoordinatorHostDeps = {},
): GitSnapshotCoordinator {
  const getLatestUserMessage = deps.getLatestUserMessage ?? defaultGetLatestUserMessage;
  const latestUserMessageInFlight = new Map<string, Promise<LatestUserMessage | null>>();
  const logger = deps.logger ?? log;

  const getLatestUserMessageOnce = (sessionId: string): Promise<LatestUserMessage | null> => {
    const cached = latestUserMessageInFlight.get(sessionId);
    if (cached) return cached;
    const promise = getLatestUserMessage(sessionId).finally(() => {
      if (latestUserMessageInFlight.get(sessionId) === promise) {
        latestUserMessageInFlight.delete(sessionId);
      }
    });
    latestUserMessageInFlight.set(sessionId, promise);
    return promise;
  };

  return new GitSnapshotCoordinator({
    readAutoSnapshotEnabled:
      deps.readAutoSnapshotEnabled ?? (() => readGitSafetySettings().autoSnapshotEnabled),
    detectRepoRoot: deps.detectRepoRoot ?? defaultDetectRepoRoot,
    initializeProjectGit:
      deps.initializeProjectGit ??
      ((sessionId, context, opts) =>
        ensureProjectGitInitialized({
          workingDir: context.workingDir,
          workspaceKind: context.workspaceKind,
          remoteHostId: context.remoteHostId,
          sessionId,
          autoSnapshotEnabled: opts.autoSnapshotEnabled,
          source: 'git-snapshot:on-turn',
        })),
    isWorktreeDirty: deps.isWorktreeDirty ?? isWorktreeDirty,
    getSessionContext: async (sessionId) => {
      const meta = await maker.getSessionMeta(sessionId);
      if (!meta?.workDir || meta.remoteHostId) return null;
      return {
        workingDir: meta.workDir,
        agentKind: meta.agentKind as AgentKind,
        workspaceKind: meta.workspaceKind,
        remoteHostId: meta.remoteHostId,
      };
    },
    resolveAnchor: async (sessionId) => (await getLatestUserMessageOnce(sessionId))?.clientId,
    getLastUserPrompt: async (sessionId) => (await getLatestUserMessageOnce(sessionId))?.text,
    createSnapshot: deps.createSnapshot ?? createSnapshot,
    createSnapshotMarker: deps.createSnapshotMarker ?? createSnapshotMarker,
    oneShot: async (agentKind, prompt) => {
      // 停用轴:快照标签是新的付费 one-shot,该 agent 的默认路由被停用时不派发 ——
      // 抛错让 labeler 走既有的确定性兜底标签(gitSnapshotLabeler:oneShot 失败即
      // fallback,PR #744 review 第十一轮)。
      if (await isAgentOneShotRouteDisabled(agentKind)) {
        throw new Error('snapshot label one-shot skipped: route disabled in settings');
      }
      return maker.oneShot(agentKind, prompt, {
        maxTokens: ONESHOT_MAX_TOKENS,
        timeoutMs: ONESHOT_TIMEOUT_MS,
      });
    },
    logger,
  });
}
