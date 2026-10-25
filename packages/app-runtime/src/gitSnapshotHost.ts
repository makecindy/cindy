/**
 * Host adapter for automatic Git snapshots.
 *
 * This file wires the pure GitSnapshotCoordinator to desktop main-process
 * dependencies: maker session metadata, repo detection, local message lookup,
 * and oneShot label generation.
 */

import type { AgentKind, Maker } from "@cindy/maker-core";
import path from "node:path";
import {
  isCindyMakeManagedWorktreePath,
  makeSourceCheckoutPath,
} from "./cindyMakeSourcePaths.js";
import { and, desc, eq, isNull } from "drizzle-orm";

import { GitSnapshotCoordinator } from "./gitSnapshotCoordinator.js";
import { extractUserPromptText } from "./userPromptText.js";
import { messages } from "@cindy/runtime-db/schema";
import type { DbLogger } from "@cindy/runtime-db/logging";
import type { DbClient } from "@cindy/runtime-db";
import type { DetectCwdResp } from "@cindy/worktree-core/types";
import type { createGitSafetySettingsStore } from "./gitSafetySettingsStore.js";
import type { createProjectGitBootstrap } from "./projectGitBootstrap.js";
import type { createGitSnapshotService } from "./gitSnapshotService.js";

interface LatestUserMessage {
  clientId: string;
  text: string;
}

/** Optional dependency overrides used by focused main-process unit tests. */
export interface GitSnapshotCoordinatorHostDeps {
  readAutoSnapshotEnabled?: () => boolean;
  readAutoInitProjectGit?: () => boolean;
  detectRepoRoot?: (workingDir: string) => Promise<string | null>;
  initializeProjectGit?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]["initializeProjectGit"];
  getLatestUserMessage?: (
    sessionId: string,
  ) => Promise<LatestUserMessage | null>;
  createShadowSavepoint?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]["createShadowSavepoint"];
  createShadowMarker?: ConstructorParameters<
    typeof GitSnapshotCoordinator
  >[0]["createShadowMarker"];
  logger?: ConstructorParameters<typeof GitSnapshotCoordinator>[0]["logger"];
}

type MakerForGitSnapshot = Pick<Maker, "getSessionMeta" | "oneShot">;
export function createGitSnapshotHost(host: {
  userDataDirectory(): string;
  createLogger(scope: string): DbLogger;
  getDbClient: () => DbClient;
  detectCwd(cwd: string): Promise<DetectCwdResp>;
  readGitSafetySettings: ReturnType<
    typeof createGitSafetySettingsStore
  >["readGitSafetySettings"];
  ensureProjectGitInitialized: ReturnType<
    typeof createProjectGitBootstrap
  >["ensureProjectGitInitialized"];
  createShadowSavepoint: ReturnType<
    typeof createGitSnapshotService
  >["createShadowSavepoint"];
  createShadowMarker: ReturnType<
    typeof createGitSnapshotService
  >["createShadowMarker"];
  isAgentOneShotRouteDisabled(agent: AgentKind): Promise<boolean>;
}) {
  const {
    createLogger,
    getDbClient,
    detectCwd,
    readGitSafetySettings,
    ensureProjectGitInitialized,
    createShadowSavepoint,
    createShadowMarker,
    isAgentOneShotRouteDisabled,
  } = host;

  const log = createLogger("git-snapshot");
  const ONESHOT_MAX_TOKENS = 80;
  const ONESHOT_TIMEOUT_MS = 20_000;

  async function defaultDetectRepoRoot(
    workingDir: string,
  ): Promise<string | null> {
    const info = await detectCwd(workingDir);
    if (
      !info.gitInstalled ||
      !info.isGitRepo ||
      !info.repoRoot ||
      info.isInsideWorktree
    ) {
      return null;
    }
    return info.repoRoot;
  }

  async function defaultGetLatestUserMessage(
    sessionId: string,
  ): Promise<LatestUserMessage | null> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ clientId: messages.clientId, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, "user"),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (!row) return null;
    return { clientId: row.clientId, text: extractUserPromptText(row.content) };
  }

  /**
   * Constructs the automatic snapshot coordinator from real desktop host deps.
   */
  function createGitSnapshotCoordinator(
    maker: MakerForGitSnapshot,
    deps: GitSnapshotCoordinatorHostDeps = {},
  ): GitSnapshotCoordinator {
    const getLatestUserMessage =
      deps.getLatestUserMessage ?? defaultGetLatestUserMessage;
    const latestUserMessageInFlight = new Map<
      string,
      Promise<LatestUserMessage | null>
    >();
    const logger = deps.logger ?? log;

    const getLatestUserMessageOnce = (
      sessionId: string,
    ): Promise<LatestUserMessage | null> => {
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
        deps.readAutoSnapshotEnabled ??
        (() => readGitSafetySettings().autoSnapshotEnabled),
      readAutoInitProjectGit:
        deps.readAutoInitProjectGit ??
        (() => readGitSafetySettings().autoInitProjectGit),
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
            source: "git-snapshot:on-turn",
          })),
      getSessionContext: async (sessionId) => {
        const meta = await maker.getSessionMeta(sessionId);
        if (!meta?.workDir || meta.remoteHostId) return null;
        // Cindy Make stores file trees itself. Generic savepoints create commit objects.
        const userData = host.userDataDirectory();
        const samePath = (a: string, b: string) =>
          process.platform === "win32"
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
      resolveAnchor: async (sessionId) =>
        (await getLatestUserMessageOnce(sessionId))?.clientId,
      getLastUserPrompt: async (sessionId) =>
        (await getLatestUserMessageOnce(sessionId))?.text,
      createShadowSavepoint:
        deps.createShadowSavepoint ?? createShadowSavepoint,
      createShadowMarker: deps.createShadowMarker ?? createShadowMarker,
      oneShot: async (agentKind, prompt) => {
        // 停用轴:快照标签是新的付费 one-shot,该 agent 的默认路由被停用时不派发 ——
        // 抛错让 labeler 走既有的确定性兜底标签(gitSnapshotLabeler:oneShot 失败即
        // fallback,PR #744 review 第十一轮)。
        if (await isAgentOneShotRouteDisabled(agentKind)) {
          throw new Error(
            "snapshot label one-shot skipped: route disabled in settings",
          );
        }
        return maker.oneShot(agentKind, prompt, {
          maxTokens: ONESHOT_MAX_TOKENS,
          timeoutMs: ONESHOT_TIMEOUT_MS,
        });
      },
      logger,
    });
  }
  return { createGitSnapshotCoordinator };
}
