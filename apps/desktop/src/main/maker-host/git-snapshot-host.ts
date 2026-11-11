/**
 * Host adapter for automatic Git snapshots.
 *
 * This file wires the pure GitSnapshotCoordinator to desktop main-process
 * dependencies: maker session metadata, repo detection, local message lookup,
 * and oneShot label generation.
 */

import type { AgentKind, Maker } from '@cindy/maker-core';
import { app } from 'electron';
import path from 'node:path';
import { currentOperationBudget, operationCheckpoint, operationWait } from '../utils/operationBudget';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState';
import { SnapshotAttemptStore } from '../git-snapshot/snapshotAttemptStore';
import {
  isCindyMakeManagedWorktreePath,
  makeSourceCheckoutPath,
} from '../cindy-make/sourcePaths.js';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { createShadowMarker, createShadowSavepoint } from '../git-snapshot/gitSnapshotService.js';
import { extractUserPromptText } from '../git-snapshot/userPromptText.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { detectCwd } from '../worktree/WorktreeManager.js';
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
  recordTurnAttempt?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]['recordTurnAttempt'];
  readAutoSnapshotEnabled?: () => boolean;
  readAutoInitProjectGit?: () => boolean;
  detectRepoRoot?: (workingDir: string) => Promise<string | null>;
  initializeProjectGit?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]['initializeProjectGit'];
  getLatestUserMessage?: (sessionId: string) => Promise<LatestUserMessage | null>;
  createShadowSavepoint?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]['createShadowSavepoint'];
  createShadowMarker?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]['createShadowMarker'];
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
    .where(
      and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), isNull(messages.rewindAt)),
    )
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
    recordTurnAttempt: deps.recordTurnAttempt ?? (async (sessionId) => {
      // Capture the owner before any await; late work must not write to the next
      // account's journal. The send boundary also rechecks the session lifetime.
      const owner = getActiveAppSession();
      if (!owner.dataOwnerId) throw new Error('Snapshot dispatch intent requires an active data owner');
      const store = new SnapshotAttemptStore(ownerScopedUserDataPath());
      const message = await operationWait(getLatestUserMessage(sessionId));
      operationCheckpoint();
      const isCurrentOwner = () => {
        const current = getActiveAppSession();
        return current.dataOwnerId === owner.dataOwnerId && current.generation === owner.generation;
      };
      if (!isCurrentOwner()) throw new Error('Snapshot dispatch owner changed');
      const attempt = await store.record(sessionId, message?.clientId);
      operationCheckpoint();
      if (!isCurrentOwner()) throw new Error('Snapshot dispatch owner changed');
      return { attemptId: attempt.id, anchor: attempt.anchor, userPrompt: message?.text };
    }),
    readAutoSnapshotEnabled:
      deps.readAutoSnapshotEnabled ?? (() => readGitSafetySettings().autoSnapshotEnabled),
    readAutoInitProjectGit:
      deps.readAutoInitProjectGit ?? (() => readGitSafetySettings().autoInitProjectGit),
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
          autoInitProjectGit: opts.autoInitProjectGit,
          source: 'git-snapshot:on-turn',
        })),
    getSessionContext: async (sessionId) => {
      const meta = await maker.getSessionMeta(sessionId);
      if (!meta?.workDir || meta.remoteHostId) return null;
      // Cindy Make stores file trees itself. Generic savepoints create commit objects.
      const userData = app.getPath('userData');
      const samePath = (a: string, b: string) =>
        process.platform === 'win32'
          ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
          : path.resolve(a) === path.resolve(b);
      if (
        isCindyMakeManagedWorktreePath(userData, meta.workDir) ||
        samePath(meta.workDir, makeSourceCheckoutPath(userData))
      )
        return null;
      return {
        workingDir: meta.workDir,
        agentKind: meta.agentKind as AgentKind,
        workspaceKind: meta.workspaceKind,
        remoteHostId: meta.remoteHostId,
        // Agent 在另一台电脑运行：文件回退统一走本机保存点链(含 Claude Code)。
        ...(meta.agentDeviceId ? { savepointRewind: true } : {}),
      };
    },
    resolveAnchor: async (sessionId) => (await getLatestUserMessageOnce(sessionId))?.clientId,
    getLastUserPrompt: async (sessionId) => (await getLatestUserMessageOnce(sessionId))?.text,
    createShadowSavepoint: deps.createShadowSavepoint ?? createShadowSavepoint,
    createShadowMarker: deps.createShadowMarker ?? createShadowMarker,
    oneShot: async (agentKind, prompt) => {
      // 停用轴:快照标签是新的付费 one-shot,该 agent 的默认路由被停用时不派发 ——
      // 抛错让 labeler 走既有的确定性兜底标签(gitSnapshotLabeler:oneShot 失败即
      // fallback,PR #744 review 第十一轮)。
      if (await operationWait(isAgentOneShotRouteDisabled(agentKind))) {
        throw new Error('snapshot label one-shot skipped: route disabled in settings');
      }
      operationCheckpoint();
      const operation = currentOperationBudget();
      return maker.oneShot(agentKind, prompt, {
        maxTokens: ONESHOT_MAX_TOKENS,
        timeoutMs: operation ? Math.max(1, Math.min(1_000, operation.deadlineAtMs - performance.now())) : ONESHOT_TIMEOUT_MS,
        ...(operation ? { signal: operation.signal } : {}),
      });
    },
    logger,
  });
}
