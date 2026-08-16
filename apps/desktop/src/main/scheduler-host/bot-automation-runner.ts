import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Maker, AgentKind, Effort } from '@cindy/maker-core';
import type {
  FireContext,
  FireResult,
  Logger,
  Schedule,
  ScheduleRunner,
} from '@cindy/maker-scheduler';

import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import {
  botAutomationLinks,
  botAutomationRuns,
  botChannels,
  botProfileVersions,
  botProfiles,
  botProjectBindings,
  botRoutes,
  botRuntimeSnapshots,
  botSessionLinks,
  botWorkspaceAttachments,
  botWorkspaceLeases,
  scheduleRuns,
  schedules,
  sessions,
} from '../localDb/schema.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { withBotAutomationMutationLock } from '../maker-ipc/botAutomationMutationLock.js';
import {
  buildSkipResultText,
  executePreRunHook,
  formatPreRunHookFailure,
} from './pre-run-hook.js';
import type { SchedulerDrizzleDb } from './storage.js';
import type {
  BotAutomationDelegateTargetSnapshot,
  BotAutomationExecutionPlan,
} from '../../shared/botAutomation.js';
import { normalizeBotAutomationExecutionPolicy } from '../../shared/botAutomation.js';
import type {
  BotDelegationCapabilitySnapshot,
  BotDelegationWorkspaceSnapshot,
} from '../../shared/botDelegation.js';
import { collectBotOutputArtifacts } from '../../shared/botOutputArtifact.js';

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      )]
    : [];
}

function configuredMode(value: unknown, configured: string[]): 'inherit' | 'allowlist' {
  return value === 'inherit' || value === 'allowlist'
    ? value
    : configured.length > 0
      ? 'allowlist'
      : 'inherit';
}

function configuredEffort(value: unknown, fallback: unknown): Effort | undefined {
  const isEffort = (candidate: unknown): candidate is Effort =>
    candidate === 'minimal'
    || candidate === 'low'
    || candidate === 'medium'
    || candidate === 'high'
    || candidate === 'xhigh'
    || candidate === 'max'
    || candidate === 'ultra';
  return isEffort(value) ? value : isEffort(fallback) ? fallback : undefined;
}

function capabilitySnapshot(input: {
  profileVersion: number;
  capabilitiesJson: string;
  identitySource: string;
}): BotDelegationCapabilitySnapshot {
  const config = parseObject(input.capabilitiesJson);
  const skills = stringList(config.skills);
  const mcpServers = stringList(config.mcpServers);
  const explicitToolsets = stringList(config.toolsets);
  const toolsets = explicitToolsets.length > 0
    ? explicitToolsets
    : stringList(config.tools).filter((item) => !['files', 'browser', 'mcp'].includes(item));
  const agentKind = config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
  return {
    profileVersion: input.profileVersion,
    agentKind,
    model:
      typeof config.model === 'string' && config.model.trim()
        ? config.model.trim()
        : agentKind === 'codex'
          ? 'gpt-5.4'
          : agentKind === 'pi'
            ? 'grok-4.5'
            : 'claude-sonnet-4-6',
    capabilitiesSha256: sha256(input.capabilitiesJson),
    identitySha256: sha256(input.identitySource),
    skills,
    skillMode: configuredMode(config.skillMode, skills),
    mcpServers,
    mcpMode: configuredMode(config.mcpMode, mcpServers),
    toolsets,
    toolsetMode: configuredMode(config.toolsetMode, toolsets),
    memoryEnabled: config.memory !== false,
    automationEnabled: config.automation === true,
  };
}

function workspaceSnapshot(
  binding: typeof botProjectBindings.$inferSelect | undefined,
): BotDelegationWorkspaceSnapshot | null {
  if (!binding) return null;
  let allowedPaths: string[] = [];
  try {
    allowedPaths = stringList(JSON.parse(binding.allowedPathsJson) as unknown);
  } catch {
    allowedPaths = [];
  }
  return {
    bindingId: binding.id,
    bindingUpdatedAt: binding.updatedAt,
    projectKey: binding.projectKey,
    workingDir: binding.workingDir,
    remoteHostId: binding.remoteHostId,
    defaultBranch: binding.defaultBranch,
    workspacePolicy: binding.workspacePolicy,
    allowedPaths,
  };
}

async function buildAutomationExecutionPlan(input: {
  db: SchedulerDrizzleDb;
  profile: typeof botProfiles.$inferSelect;
  version: typeof botProfileVersions.$inferSelect;
  binding: typeof botProjectBindings.$inferSelect | undefined;
  executionPolicyJson: string;
  targetRouteId: string | null;
  targetRouteOwnerGeneration: number | null;
  createdAt: number;
}): Promise<BotAutomationExecutionPlan> {
  const policy = normalizeBotAutomationExecutionPolicy(parseObject(input.executionPolicyJson));
  let targetBotIds: string[] = [];
  if (policy.delegateTargetMode === 'allowlist') {
    targetBotIds = policy.allowedDelegateBotIds.filter((botId) => botId !== input.profile.id);
  } else if (policy.delegateTargetMode === 'all-active') {
    targetBotIds = (await input.db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.status, 'active')))
      .map((row) => row.id)
      .filter((botId) => botId !== input.profile.id);
  }
  const uniqueTargetIds = [...new Set(targetBotIds)];
  const targetSnapshots: BotAutomationDelegateTargetSnapshot[] = [];
  if (uniqueTargetIds.length > 0) {
    const targets = await input.db
      .select()
      .from(botProfiles)
      .where(
        and(
          inArray(botProfiles.id, uniqueTargetIds),
          eq(botProfiles.status, 'active'),
        ),
      );
    if (targets.length !== uniqueTargetIds.length) {
      throw new Error('One or more Automation delegate targets are unavailable');
    }
    const versions = await input.db
      .select()
      .from(botProfileVersions)
      .where(inArray(botProfileVersions.botId, uniqueTargetIds));
    const defaultBindings = await input.db
      .select()
      .from(botProjectBindings)
      .where(
        and(
          inArray(botProjectBindings.botId, uniqueTargetIds),
          eq(botProjectBindings.status, 'active'),
          eq(botProjectBindings.isDefault, true),
        ),
      );
    const defaultBindingByBot = new Map(defaultBindings.map((binding) => [binding.botId, binding]));
    for (const target of targets) {
      const version = versions.find(
        (candidate) => candidate.botId === target.id && candidate.version === target.currentVersion,
      );
      if (!version) throw new Error(`Automation delegate target Profile is unavailable: ${target.id}`);
      targetSnapshots.push({
        botId: target.id,
        profileVersion: target.currentVersion,
        capabilitiesSha256: sha256(version.capabilitiesJson),
        identitySha256: sha256(version.identitySource),
        defaultWorkspace: workspaceSnapshot(defaultBindingByBot.get(target.id)),
      });
    }
  }
  return {
    version: 1,
    createdAt: input.createdAt,
    deadlineAt: input.createdAt + policy.timeoutMs,
    botId: input.profile.id,
    profile: capabilitySnapshot({
      profileVersion: input.profile.currentVersion,
      capabilitiesJson: input.version.capabilitiesJson,
      identitySource: input.version.identitySource,
    }),
    workspace: workspaceSnapshot(input.binding),
    delivery: {
      targetRouteId: input.targetRouteId,
      ownerGeneration: input.targetRouteOwnerGeneration,
    },
    limits: {
      timeoutMs: policy.timeoutMs,
      budgetTokens: policy.budgetTokens,
      maxDelegationDepth: policy.maxDelegationDepth,
    },
    delegation: {
      mode: policy.delegateTargetMode,
      targets: targetSnapshots,
    },
  };
}

async function validateAutomationExecutionPlan(
  db: SchedulerDrizzleDb,
  plan: BotAutomationExecutionPlan,
): Promise<void> {
  if (Date.now() >= plan.deadlineAt) throw new Error('Bot automation execution deadline expired');
  const [profile] = await db
    .select()
    .from(botProfiles)
    .where(eq(botProfiles.id, plan.botId))
    .limit(1);
  if (
    !profile
    || profile.status !== 'active'
    || profile.currentVersion !== plan.profile.profileVersion
  ) {
    throw new Error('Bot automation Profile changed after this run was claimed');
  }
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, plan.botId),
        eq(botProfileVersions.version, plan.profile.profileVersion),
      ),
    )
    .limit(1);
  if (
    !version
    || sha256(version.capabilitiesJson) !== plan.profile.capabilitiesSha256
    || sha256(version.identitySource) !== plan.profile.identitySha256
  ) {
    throw new Error('Bot automation Profile bytes changed after this run was claimed');
  }
  if (plan.workspace) {
    const [binding] = await db
      .select()
      .from(botProjectBindings)
      .where(eq(botProjectBindings.id, plan.workspace.bindingId))
      .limit(1);
    if (
      !binding
      || binding.status !== 'active'
      || binding.botId !== plan.botId
      || binding.updatedAt !== plan.workspace.bindingUpdatedAt
      || binding.projectKey !== plan.workspace.projectKey
    ) {
      throw new Error('Bot automation workspace authorization changed after this run was claimed');
    }
  }
  for (const target of plan.delegation.targets) {
    const [targetProfile] = await db
      .select()
      .from(botProfiles)
      .where(eq(botProfiles.id, target.botId))
      .limit(1);
    if (
      !targetProfile
      || targetProfile.status !== 'active'
      || targetProfile.currentVersion !== target.profileVersion
    ) {
      throw new Error(`Automation delegate target changed: ${target.botId}`);
    }
    const [targetVersion] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, target.botId),
          eq(botProfileVersions.version, target.profileVersion),
        ),
      )
      .limit(1);
    if (
      !targetVersion
      || sha256(targetVersion.capabilitiesJson) !== target.capabilitiesSha256
      || sha256(targetVersion.identitySource) !== target.identitySha256
    ) {
      throw new Error(`Automation delegate target Profile bytes changed: ${target.botId}`);
    }
    const [currentBinding] = await db
      .select()
      .from(botProjectBindings)
      .where(
        and(
          eq(botProjectBindings.botId, target.botId),
          eq(botProjectBindings.status, 'active'),
          eq(botProjectBindings.isDefault, true),
        ),
      )
      .limit(1);
    if (
      target.defaultWorkspace === null
        ? currentBinding !== undefined
        : !currentBinding
          || currentBinding.id !== target.defaultWorkspace.bindingId
          || currentBinding.updatedAt !== target.defaultWorkspace.bindingUpdatedAt
          || currentBinding.projectKey !== target.defaultWorkspace.projectKey
    ) {
      throw new Error(`Automation delegate target workspace changed: ${target.botId}`);
    }
  }
}

export async function requireStrictAutomationRuntime(
  db: SchedulerDrizzleDb,
  sessionId: string,
  plan: BotAutomationExecutionPlan,
): Promise<void> {
  const [runtime] = await db
    .select()
    .from(botRuntimeSnapshots)
    .where(eq(botRuntimeSnapshots.sessionId, sessionId))
    .orderBy(desc(botRuntimeSnapshots.preparedAt))
    .limit(1);
  if (!runtime || runtime.profileVersion !== plan.profile.profileVersion) {
    throw new Error('Bot automation runtime did not produce the frozen Profile snapshot');
  }
  if (runtime.status !== 'applied') {
    const failure = parseObject(runtime.failureJson);
    const detail = [failure.stage, failure.errorCode ?? failure.errorName]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(': ');
    throw new Error(
      runtime.status === 'degraded'
        ? 'Bot automation runtime is degraded because one or more frozen capabilities are unavailable'
        : `Bot automation runtime failed to start${detail ? ` (${detail})` : ''}`,
    );
  }
  const resolved = parseObject(runtime.resolvedJson);
  const unavailable = [
    ...stringList(resolved.unavailableSkills),
    ...stringList(resolved.unavailableMcpServers),
    ...stringList(resolved.unavailableToolsets),
  ];
  const memoryUnavailable = Array.isArray(resolved.memoryRefs)
    && resolved.memoryRefs.some(
      (ref) => ref
        && typeof ref === 'object'
        && (ref as Record<string, unknown>).status === 'unavailable',
    );
  if (unavailable.length > 0 || memoryUnavailable) {
    throw new Error(
      `Bot automation runtime is missing frozen capabilities: ${[
        ...unavailable,
        ...(memoryUnavailable ? ['memory'] : []),
      ].join(', ')}`,
    );
  }
}

function schedulePerTaskWorkspaceReclaim(sessionId: string): void {
  void import('../maker-ipc/botWorkspaceRuntime.js')
    .then((module) => module.schedulePerTaskBotWorkspaceReclaim(sessionId))
    .catch(() => undefined);
}

function agentKindFor(config: Record<string, unknown>): AgentKind {
  return config.harness === 'codex'
    ? 'codex'
    : config.harness === 'pi'
      ? 'pi'
      : 'claude-code';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const message = errorText(error).toLowerCase();
  return error instanceof DOMException && error.name === 'AbortError'
    || message.includes('abort');
}

export interface BotAutomationScheduleRunnerDeps {
  delegate: ScheduleRunner;
  maker: Maker;
  getDb: () => SchedulerDrizzleDb;
  logger?: Logger;
  onSessionCreated?: (sessionId: string) => void;
  archiveSession?: (sessionId: string) => Promise<void>;
  enqueueDelivery?: (params: {
    botId: string;
    channelId?: string | null;
    routeId?: string | null;
    sessionId: string | null;
    idempotencyKey: string;
    ownerGeneration?: number;
    payload: {
      version: 1;
      kind: 'session-message';
      targetSessionId: string;
      fallbackBotId: string;
      clientId: string;
      message: string;
      persistedContent: string;
    };
  }) => Promise<{ id: string }>;
}

type BotAutomationDeliveryTarget = {
  sessionId: string;
  channelId: string | null;
  routeId: string | null;
  ownerGeneration: number;
};

async function resolveBotAutomationDeliveryTarget(
  db: SchedulerDrizzleDb,
  automationLinkId: string,
  targetRouteId: string | null,
  botId: string,
  expectedOwnerGeneration: number | null,
): Promise<
  | { ok: true; target: BotAutomationDeliveryTarget | null }
  | { ok: false; error: string }
> {
  const [automation] = await db
    .select({
      status: botAutomationLinks.status,
      scheduleStatus: schedules.status,
    })
    .from(botAutomationLinks)
    .leftJoin(schedules, eq(schedules.id, botAutomationLinks.scheduleId))
    .where(and(eq(botAutomationLinks.id, automationLinkId), eq(botAutomationLinks.botId, botId)))
    .limit(1);
  if (!automation || automation.status !== 'active' || automation.scheduleStatus !== 'active') {
    return { ok: false, error: 'Bot automation is no longer active; completion was not delivered' };
  }
  const [profile] = await db
    .select({
      canonicalSessionId: botProfiles.canonicalSessionId,
      status: botProfiles.status,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile || profile.status !== 'active') {
    return { ok: false, error: 'Bot is no longer active; completion was not delivered' };
  }
  if (targetRouteId) {
    const [route] = await db
      .select({
        currentSessionId: botRoutes.currentSessionId,
        channelId: botRoutes.channelId,
        ownerGeneration: botRoutes.ownerGeneration,
        status: botRoutes.status,
      })
      .from(botRoutes)
      .where(and(eq(botRoutes.id, targetRouteId), eq(botRoutes.botId, botId)))
      .limit(1);
    if (route?.status === 'active' && route.currentSessionId) {
      if (
        expectedOwnerGeneration !== null
        && route.ownerGeneration !== expectedOwnerGeneration
      ) {
        return {
          ok: false,
          error: 'Target route ownership changed while the automation was running',
        };
      }
      return {
        ok: true,
        target: {
          sessionId: route.currentSessionId,
          channelId: route.channelId,
          routeId: targetRouteId,
          ownerGeneration: route.ownerGeneration,
        },
      };
    }
    return {
      ok: false,
      error: route
        ? `Target route is ${route.status} or has no active task`
        : 'Target route no longer exists',
    };
  }
  return {
    ok: true,
    target: profile.canonicalSessionId
      ? {
          sessionId: profile.canonicalSessionId,
          channelId: null,
          routeId: null,
          ownerGeneration: 0,
        }
      : null,
  };
}

export class BotAutomationScheduleRunner implements ScheduleRunner {
  constructor(private readonly deps: BotAutomationScheduleRunnerDeps) {}

  async fire(schedule: Schedule, ctx: FireContext): Promise<FireResult> {
    const db = this.deps.getDb();
    const claimedState = await withBotAutomationMutationLock(schedule.id, async () => {
      const [link] = await db
        .select()
        .from(botAutomationLinks)
        .where(eq(botAutomationLinks.scheduleId, schedule.id))
        .limit(1);
      if (!link) {
        if (schedule.source === 'bot') {
          throw new Error('Bot automation ownership link is unavailable');
        }
        return null;
      }
      if (schedule.source !== 'bot') {
        throw new Error('Bot automation ownership mismatch');
      }
      if (link.status !== 'active') {
        throw new Error(`Bot automation is ${link.status}`);
      }

      const [activeRun] = await db
        .select({ id: botAutomationRuns.id })
        .from(botAutomationRuns)
        .where(
          and(
            eq(botAutomationRuns.automationLinkId, link.id),
            inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
          ),
        )
        .limit(1);
      if (activeRun) {
        return { busy: true as const, automationRunId: activeRun.id };
      }

      const [profile] = await db
        .select()
        .from(botProfiles)
        .where(and(eq(botProfiles.id, link.botId), eq(botProfiles.status, 'active')))
        .limit(1);
      if (!profile) throw new Error('Bot automation profile is unavailable');
      const [version] = await db
        .select()
        .from(botProfileVersions)
        .where(
          and(
            eq(botProfileVersions.botId, profile.id),
            eq(botProfileVersions.version, profile.currentVersion),
          ),
        )
        .limit(1);
      if (!version) throw new Error('Bot automation Profile version is unavailable');
      const config = parseObject(version.capabilitiesJson);
      if (config.automation !== true) {
        throw new Error('Bot automation is disabled in the current Profile');
      }
      if (config.permissions !== 'trusted') {
        throw new Error(
          'Bot automation requires trusted operations because no user is present to approve',
        );
      }

      let binding: typeof botProjectBindings.$inferSelect | undefined;
      if (link.projectBindingId) {
        [binding] = await db
          .select()
          .from(botProjectBindings)
          .where(
            and(
              eq(botProjectBindings.id, link.projectBindingId),
              eq(botProjectBindings.botId, profile.id),
              eq(botProjectBindings.status, 'active'),
            ),
          )
          .limit(1);
        if (!binding) throw new Error('Bot automation project binding is unavailable');
      } else {
        [binding] = await db
          .select()
          .from(botProjectBindings)
          .where(
            and(
              eq(botProjectBindings.botId, profile.id),
              eq(botProjectBindings.status, 'active'),
              eq(botProjectBindings.isDefault, true),
            ),
          )
          .limit(1);
      }

      let targetRouteOwnerGenerationSnapshot: number | null = null;
      if (link.targetRouteId) {
        const [targetRoute] = await db
          .select({
            botId: botRoutes.botId,
            ownerGeneration: botRoutes.ownerGeneration,
            currentSessionId: botRoutes.currentSessionId,
            status: botRoutes.status,
          })
          .from(botRoutes)
          .where(eq(botRoutes.id, link.targetRouteId))
          .limit(1);
        if (
          !targetRoute
          || targetRoute.botId !== profile.id
          || targetRoute.status !== 'active'
          || !targetRoute.currentSessionId
        ) {
          throw new Error('Bot automation target route is unavailable');
        }
        targetRouteOwnerGenerationSnapshot = targetRoute.ownerGeneration;
      }

      const createdAt = Date.now();
      const automationRunId = randomUUID();
      const executionPlan = await buildAutomationExecutionPlan({
        db,
        profile,
        version,
        binding,
        executionPolicyJson: link.executionPolicyJson,
        targetRouteId: link.targetRouteId,
        targetRouteOwnerGeneration: targetRouteOwnerGenerationSnapshot,
        createdAt,
      });
      const claimed = await db
        .insert(botAutomationRuns)
        .values({
          id: automationRunId,
          automationLinkId: link.id,
          scheduleRunId: ctx.runId,
          sessionId: null,
          workspaceLeaseId: null,
          profileVersion: profile.currentVersion,
          projectBindingIdSnapshot: binding?.id ?? null,
          targetRouteIdSnapshot: link.targetRouteId,
          targetRouteOwnerGenerationSnapshot,
          workingDirSnapshot: binding?.workingDir ?? null,
          remoteHostIdSnapshot: binding?.remoteHostId ?? null,
          worktreePathSnapshot: null,
          deliveryOutboxId: null,
          deliveryStatus: 'not-requested',
          deliveryError: null,
          executionPlanJson: JSON.stringify(executionPlan),
          status: 'claimed',
          createdAt,
          updatedAt: createdAt,
          finishedAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: botAutomationRuns.id });
      if (claimed.length === 0) {
        throw new Error('Bot automation run was already claimed');
      }
      return {
        busy: false as const,
        link,
        profile,
        config,
        binding,
        createdAt,
        automationRunId,
        targetRouteOwnerGenerationSnapshot,
        executionPlan,
      };
    });
    if (!claimedState) return this.deps.delegate.fire(schedule, ctx);
    if (claimedState.busy) {
      return {
        sessionId: '',
        skipped: true,
        resultText: `Bot automation is already running (${claimedState.automationRunId}).`,
      };
    }
    const {
      link,
      profile,
      config,
      binding,
      createdAt,
      automationRunId,
      targetRouteOwnerGenerationSnapshot,
      executionPlan,
    } = claimedState;

    try {
      if (schedule.preRunHook?.command?.trim()) {
        const hook = await executePreRunHook({
          command: schedule.preRunHook.command,
          timeoutMs: schedule.preRunHook.timeoutMs,
          cwd: binding?.workingDir,
          signal: ctx.signal,
          stdinPayload: {
            event: 'schedule-pre-run',
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            runId: ctx.runId,
            firedAt: ctx.firedAt,
            workingDir: binding?.workingDir,
            lastFinishedAt: schedule.lastFinishedAt,
          },
        });
        await ctx.onPreRunHookCompleted?.(hook);
        if (hook.status === 'aborted' || ctx.signal.aborted) {
          throw new Error('fire aborted during Bot automation pre-run hook');
        }
        if (hook.decision === 'skip') {
          await this.finalizeClaimOnly(automationRunId, 'skipped');
          return { sessionId: '', skipped: true, resultText: buildSkipResultText(hook) };
        }
        if (hook.decision === 'block') {
          throw new Error(formatPreRunHookFailure(hook));
        }
      }
    } catch (error) {
      await this.finalizeClaimOnly(
        automationRunId,
        isAbort(error, ctx.signal) ? 'aborted' : 'failed',
      );
      throw error;
    }

    try {
      await validateAutomationExecutionPlan(db, executionPlan);
    } catch (error) {
      await this.finalizeClaimOnly(
        automationRunId,
        isAbort(error, ctx.signal) ? 'aborted' : 'failed',
      );
      throw error;
    }

    const sessionId = randomUUID();
    const workspaceKind = binding ? 'project' : 'dialogue';
    const workingDir = binding?.workingDir ?? ensureDialogueWorkspaceDir(sessionId, createdAt);
    const agentKind: AgentKind = executionPlan.profile.agentKind === 'cc'
      ? 'claude-code'
      : executionPlan.profile.agentKind;
    const model = executionPlan.profile.model;
    const localChannelId = `${profile.id}:local`;
    try {
      await ensureProjectGitInitialized({
        workingDir,
        workspaceKind,
        remoteHostId: binding?.remoteHostId ?? null,
        sessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'bot-automation',
      });
      const sessionRow = {
        ...sessionCreateToRow(
          sessionId,
          {
            workspaceKind,
            workingDir,
            model,
            agentKind: agentKind === 'claude-code' ? 'cc' : agentKind,
            permissionMode: 'bypassPermissions',
            remoteHostId: binding?.remoteHostId ?? undefined,
            source: 'bot',
          },
          createdAt,
        ),
        title: `${profile.displayName} · ${schedule.name}`.slice(0, 120),
      };
      await getDbClient().tx('bots.createAutomationSession', {
        automationRunId,
        botId: profile.id,
        localChannelId,
        profileVersion: profile.currentVersion,
        routeKey: `automation:${ctx.runId}`,
        workingDirSnapshot: workingDir,
        remoteHostIdSnapshot: binding?.remoteHostId ?? null,
        session: {
          id: sessionRow.id,
          title: sessionRow.title,
          workingDir: sessionRow.workingDir ?? null,
          workspaceKind: sessionRow.workspaceKind,
          model: sessionRow.model,
          effort: sessionRow.effort,
          permissionMode: sessionRow.permissionMode,
          agentKind: sessionRow.agentKind,
          remoteHostId: sessionRow.remoteHostId ?? null,
          providerId: sessionRow.providerId ?? null,
          extraDirs: sessionRow.extraDirs,
          source: sessionRow.source,
          createdAt: sessionRow.createdAt,
          updatedAt: sessionRow.updatedAt,
        },
        now: Date.now(),
      });
    } catch (error) {
      // Only reclaim the exact app-owned dialogue directory allocated above.
      // A project binding is user-owned and must never be failure-cleaned here.
      if (workspaceKind === 'dialogue') {
        await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await this.finalizeClaimOnly(
        automationRunId,
        isAbort(error, ctx.signal) ? 'aborted' : 'failed',
      );
      throw error;
    }
    this.deps.onSessionCreated?.(sessionId);
    try {
      await ctx.onSessionBound?.(sessionId);
    } catch (error) {
      this.deps.logger?.warn?.('[bot-automation] session bind broadcast failed (non-fatal)', {
        scheduleId: schedule.id,
        runId: ctx.runId,
        sessionId,
        error: errorText(error),
      });
    }

    const runStartedAt = Date.now();
    await db
      .update(botAutomationRuns)
      .set({ status: 'running', updatedAt: runStartedAt })
      .where(eq(botAutomationRuns.id, automationRunId));

    const delegatedSchedule: Schedule = {
      ...schedule,
      prompt: [
        `Cindy Bot automation: ${schedule.name}`,
        `Automation run: ${ctx.runId}`,
        schedule.prompt,
      ].join('\n\n'),
      targetSessionId: sessionId,
      persistentSession: false,
      agentKind,
      model,
      providerId: typeof config.providerId === 'string' ? config.providerId : undefined,
      effort: typeof config.effort === 'string' ? config.effort : schedule.effort,
      fastMode: typeof config.fastMode === 'boolean' ? config.fastMode : schedule.fastMode,
      workspaceKind,
      workingDir,
      useWorktree: false,
      preRunHook: undefined,
    };

    let result: FireResult;
    let deadlineExpired = false;
    const runAbort = new AbortController();
    const abortFromScheduler = () => runAbort.abort(ctx.signal.reason);
    if (ctx.signal.aborted) abortFromScheduler();
    else ctx.signal.addEventListener('abort', abortFromScheduler, { once: true });
    const remainingMs = Math.max(1, executionPlan.deadlineAt - Date.now());
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      runAbort.abort(new Error('Bot automation execution deadline expired'));
    }, remainingMs);
    deadlineTimer.unref?.();
    try {
      await this.deps.maker.createSession({
        id: sessionId,
        agentKind,
        workingDir,
        model,
        effort: configuredEffort(config.effort, schedule.effort),
        fastMode: typeof config.fastMode === 'boolean' ? config.fastMode : schedule.fastMode,
        permissionMode: 'bypassPermissions',
        providerId: typeof config.providerId === 'string' ? config.providerId : undefined,
        remoteHostId: binding?.remoteHostId ?? undefined,
        title: `${profile.displayName} · ${schedule.name}`.slice(0, 120),
        vendorOptions: { source: 'scheduler' },
      });
      if (runAbort.signal.aborted) {
        throw runAbort.signal.reason ?? new Error('Bot automation aborted during runtime startup');
      }
      await requireStrictAutomationRuntime(db, sessionId, executionPlan);
      result = await this.deps.delegate.fire(
        delegatedSchedule,
        { ...ctx, signal: runAbort.signal },
      );
      // The Bot may have been paused/archived while the agent was running. Scheduler
      // cancellation is cooperative, so a runner that settles at the same moment must
      // still re-check the frozen lifecycle generation before entering completion.
      await validateAutomationExecutionPlan(db, executionPlan);
      const [runState] = await db
        .select({ status: botAutomationRuns.status, errorMessage: botAutomationRuns.errorMessage })
        .from(botAutomationRuns)
        .where(eq(botAutomationRuns.id, automationRunId))
        .limit(1);
      if (runState?.status === 'failed') {
        throw new Error(runState.errorMessage ?? 'Bot automation failed during execution');
      }
    } catch (error) {
      const [runState] = await db
        .select({ status: botAutomationRuns.status, errorMessage: botAutomationRuns.errorMessage })
        .from(botAutomationRuns)
        .where(eq(botAutomationRuns.id, automationRunId))
        .limit(1);
      const externallyFailed = runState?.status === 'failed';
      const status = deadlineExpired || externallyFailed
        ? 'failed'
        : isAbort(error, ctx.signal)
          ? 'aborted'
          : 'failed';
      await this.finalizeRun({
        automationRunId,
        sessionId,
        status,
        errorMessage: externallyFailed
          ? runState.errorMessage
          : errorText(error),
      });
      if (deadlineExpired) throw new Error('Bot automation execution deadline expired');
      if (externallyFailed && runState.errorMessage) throw new Error(runState.errorMessage);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      ctx.signal.removeEventListener('abort', abortFromScheduler);
    }

    const resultTextSnapshot = result.resultText?.trim() || null;
    const outputArtifactsJson = JSON.stringify(collectBotOutputArtifacts(resultTextSnapshot));
    await db
      .update(botAutomationRuns)
      .set({
        status: 'completing',
        resultTextSnapshot,
        outputArtifactsJson,
        updatedAt: Date.now(),
      })
      .where(eq(botAutomationRuns.id, automationRunId));

    const deliveryTarget = await this.resolveDeliveryTarget(
      link.id,
      link.targetRouteId,
      profile.id,
      targetRouteOwnerGenerationSnapshot,
    );
    if (deliveryTarget.ok && deliveryTarget.target && this.deps.enqueueDelivery) {
      const text = [
        `[Cindy Bot automation ${schedule.name} completed]`,
        resultTextSnapshot ? `Result:\n${resultTextSnapshot}` : '',
        `Run task: ${sessionId}`,
      ].filter(Boolean).join('\n\n');
      try {
        const delivery = await this.deps.enqueueDelivery({
          botId: profile.id,
          channelId: deliveryTarget.target.channelId,
          routeId: deliveryTarget.target.routeId,
          sessionId: deliveryTarget.target.sessionId,
          ownerGeneration: deliveryTarget.target.ownerGeneration,
          idempotencyKey: `bot-automation-completion:${ctx.runId}`,
          payload: {
            version: 1,
            kind: 'session-message',
            targetSessionId: deliveryTarget.target.sessionId,
            fallbackBotId: profile.id,
            clientId: `bot-automation-completion:${ctx.runId}`,
            message: text,
            persistedContent: text,
          },
        });
        await db
          .update(botAutomationRuns)
          .set({
            deliveryOutboxId: delivery.id,
            deliveryStatus: 'queued',
            deliveryError: null,
            updatedAt: Date.now(),
          })
          .where(eq(botAutomationRuns.id, automationRunId));
      } catch (error) {
        // Agent execution and result delivery are independent state machines.
        // Never rewrite a successful run as failed merely because its notification
        // could not be enqueued; the outbox/diagnostics layer owns retries.
        this.deps.logger?.warn?.('[bot-automation] completion delivery enqueue failed', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          sessionId,
          routeId: deliveryTarget.target.routeId,
          error: errorText(error),
        });
        await db
          .update(botAutomationRuns)
          .set({
            deliveryStatus: 'enqueue-failed',
            deliveryError: errorText(error).slice(0, 4_000),
            updatedAt: Date.now(),
          })
          .where(eq(botAutomationRuns.id, automationRunId));
      }
    } else if (!deliveryTarget.ok) {
      await db
        .update(botAutomationRuns)
        .set({
          deliveryStatus: 'enqueue-failed',
          deliveryError: deliveryTarget.error,
          updatedAt: Date.now(),
        })
        .where(eq(botAutomationRuns.id, automationRunId));
    } else if (deliveryTarget.target && !this.deps.enqueueDelivery) {
      await db
        .update(botAutomationRuns)
        .set({
          deliveryStatus: 'enqueue-failed',
          deliveryError: 'Bot delivery outbox is not initialized',
          updatedAt: Date.now(),
        })
          .where(eq(botAutomationRuns.id, automationRunId));
    }
    await this.finalizeRun({ automationRunId, sessionId, status: 'success' });
    return result;
  }

  private async finalizeClaimOnly(
    automationRunId: string,
    status: 'failed' | 'aborted' | 'skipped',
  ): Promise<void> {
    const finishedAt = Date.now();
    await this.deps
      .getDb()
      .update(botAutomationRuns)
      .set({ status, updatedAt: finishedAt, finishedAt })
      .where(eq(botAutomationRuns.id, automationRunId));
  }

  private async finalizeRun(input: {
    automationRunId: string;
    sessionId: string;
    status: 'success' | 'failed' | 'aborted';
    errorMessage?: string | null;
  }): Promise<void> {
    const db = this.deps.getDb();
    const finishedAt = Date.now();
    const [attachment] = await db
      .select({
        leaseId: botWorkspaceAttachments.leaseId,
        worktreePath: botWorkspaceLeases.worktreePath,
      })
      .from(botWorkspaceAttachments)
      .leftJoin(botWorkspaceLeases, eq(botWorkspaceLeases.id, botWorkspaceAttachments.leaseId))
      .where(
        and(
          eq(botWorkspaceAttachments.sessionId, input.sessionId),
          isNull(botWorkspaceAttachments.detachedAt),
        ),
      )
      .orderBy(desc(botWorkspaceAttachments.createdAt))
      .limit(1);
    await getDbClient().tx('bots.finalizeAutomationRun', {
      automationRunId: input.automationRunId,
      sessionId: input.sessionId,
      status: input.status,
      errorMessage: input.status === 'success'
        ? null
        : input.errorMessage?.slice(0, 4_000) ?? null,
      workspaceLeaseId: attachment?.leaseId ?? null,
      worktreePathSnapshot: attachment?.worktreePath ?? null,
      finishedAt,
    });
    await (this.deps.archiveSession?.(input.sessionId) ?? db
      .update(sessions)
      .set({ status: 'archived', updatedAt: finishedAt })
      .where(eq(sessions.id, input.sessionId))
      .then(() => undefined)).catch((error) => {
      this.deps.logger?.warn?.('[bot-automation] task archive failed; startup reconcile will retry', {
        sessionId: input.sessionId,
        error: errorText(error),
      });
    });
    await this.deps.maker.closeSession(input.sessionId).catch((error) => {
      this.deps.logger?.warn?.('[bot-automation] runtime close failed (non-fatal)', {
        sessionId: input.sessionId,
        error: errorText(error),
      });
    });
    schedulePerTaskWorkspaceReclaim(input.sessionId);
  }

  private async resolveDeliveryTarget(
    automationLinkId: string,
    targetRouteId: string | null,
    botId: string,
    expectedOwnerGeneration: number | null,
  ): ReturnType<typeof resolveBotAutomationDeliveryTarget> {
    return resolveBotAutomationDeliveryTarget(
      this.deps.getDb(),
      automationLinkId,
      targetRouteId,
      botId,
      expectedOwnerGeneration,
    );
  }
}

export async function reconcileBotAutomationRuns(
  deps: {
    getDb: () => SchedulerDrizzleDb;
    maker: Maker;
    logger?: Logger;
    archiveSession?: (sessionId: string) => Promise<void>;
    enqueueDelivery?: BotAutomationScheduleRunnerDeps['enqueueDelivery'];
  },
): Promise<void> {
  const db = deps.getDb();
  const rows = await db
    .select({
      id: botAutomationRuns.id,
      automationLinkId: botAutomationRuns.automationLinkId,
      status: botAutomationRuns.status,
      scheduleRunId: botAutomationRuns.scheduleRunId,
      sessionId: botAutomationRuns.sessionId,
      finishedAt: botAutomationRuns.finishedAt,
      resultTextSnapshot: botAutomationRuns.resultTextSnapshot,
      targetRouteIdSnapshot: botAutomationRuns.targetRouteIdSnapshot,
      targetRouteOwnerGenerationSnapshot: botAutomationRuns.targetRouteOwnerGenerationSnapshot,
      deliveryOutboxId: botAutomationRuns.deliveryOutboxId,
      deliveryStatus: botAutomationRuns.deliveryStatus,
      botId: botAutomationLinks.botId,
      scheduleName: schedules.name,
      sessionStatus: sessions.status,
    })
    .from(botAutomationRuns)
    .innerJoin(
      botAutomationLinks,
      eq(botAutomationLinks.id, botAutomationRuns.automationLinkId),
    )
    .leftJoin(sessions, eq(sessions.id, botAutomationRuns.sessionId))
    .leftJoin(scheduleRuns, eq(scheduleRuns.id, botAutomationRuns.scheduleRunId))
    .leftJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(
      or(
        inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
        and(
          eq(botAutomationRuns.status, 'success'),
          ne(scheduleRuns.status, 'success'),
        ),
      ),
    );
  const now = Date.now();
  for (const row of rows) {
    let terminalStatus = row.status;
    let terminalAt = row.finishedAt ?? now;
    if (row.status === 'success') {
      terminalAt = row.finishedAt ?? now;
      if (row.scheduleRunId) {
        await db
          .update(scheduleRuns)
          .set({
            status: 'success',
            resultText: row.resultTextSnapshot,
            finishedAt: terminalAt,
            heartbeatAt: null,
          })
          .where(
            and(
              eq(scheduleRuns.id, row.scheduleRunId),
              ne(scheduleRuns.status, 'success'),
            ),
          );
      }
    } else if (row.status === 'completing') {
      terminalStatus = 'success';
      terminalAt = now;
      if (row.scheduleRunId) {
        await db
          .update(scheduleRuns)
          .set({
            status: 'success',
            resultText: row.resultTextSnapshot,
            finishedAt: terminalAt,
            heartbeatAt: null,
          })
          .where(eq(scheduleRuns.id, row.scheduleRunId));
      }
      if (!row.deliveryOutboxId && row.deliveryStatus === 'not-requested' && row.sessionId) {
        const deliveryTarget = await resolveBotAutomationDeliveryTarget(
          db,
          row.automationLinkId,
          row.targetRouteIdSnapshot,
          row.botId,
          row.targetRouteOwnerGenerationSnapshot,
        );
        if (deliveryTarget.ok && deliveryTarget.target && deps.enqueueDelivery) {
          const stableRunIdentity = row.scheduleRunId ?? row.id;
          const deliveryKey = `bot-automation-completion:${stableRunIdentity}`;
          const text = [
            `[Cindy Bot automation ${row.scheduleName ?? 'Automation'} completed]`,
            row.resultTextSnapshot ? `Result:\n${row.resultTextSnapshot}` : '',
            `Run task: ${row.sessionId}`,
          ].filter(Boolean).join('\n\n');
          try {
            const delivery = await deps.enqueueDelivery({
              botId: row.botId,
              channelId: deliveryTarget.target.channelId,
              routeId: deliveryTarget.target.routeId,
              sessionId: deliveryTarget.target.sessionId,
              ownerGeneration: deliveryTarget.target.ownerGeneration,
              idempotencyKey: deliveryKey,
              payload: {
                version: 1,
                kind: 'session-message',
                targetSessionId: deliveryTarget.target.sessionId,
                fallbackBotId: row.botId,
                clientId: deliveryKey,
                message: text,
                persistedContent: text,
              },
            });
            await db
              .update(botAutomationRuns)
              .set({
                deliveryOutboxId: delivery.id,
                deliveryStatus: 'queued',
                deliveryError: null,
                updatedAt: now,
              })
              .where(eq(botAutomationRuns.id, row.id));
          } catch (error) {
            await db
              .update(botAutomationRuns)
              .set({
                deliveryStatus: 'enqueue-failed',
                deliveryError: errorText(error).slice(0, 4_000),
                updatedAt: now,
              })
              .where(eq(botAutomationRuns.id, row.id));
          }
        } else if (!deliveryTarget.ok || (deliveryTarget.target && !deps.enqueueDelivery)) {
          await db
            .update(botAutomationRuns)
            .set({
              deliveryStatus: 'enqueue-failed',
              deliveryError: deliveryTarget.ok
                ? 'Bot delivery outbox is not initialized'
                : deliveryTarget.error,
              updatedAt: now,
            })
            .where(eq(botAutomationRuns.id, row.id));
        }
      }
      await db
        .update(botAutomationRuns)
        .set({ status: 'success', updatedAt: now, finishedAt: terminalAt })
        .where(eq(botAutomationRuns.id, row.id));
    } else if (row.status === 'claimed' || row.status === 'running') {
      const [scheduleRun] = row.scheduleRunId
        ? await db
            .select({ status: scheduleRuns.status, finishedAt: scheduleRuns.finishedAt })
            .from(scheduleRuns)
            .where(eq(scheduleRuns.id, row.scheduleRunId))
            .limit(1)
        : [];
      if (scheduleRun?.status === 'running') continue;
      terminalStatus = scheduleRun?.status === 'success'
        ? 'success'
        : scheduleRun?.status === 'failed'
          ? 'failed'
          : scheduleRun?.status === 'aborted'
            ? 'aborted'
            : scheduleRun?.status === 'interrupted'
              ? 'interrupted'
              : 'unknown';
      terminalAt = scheduleRun?.finishedAt ?? now;
      await db
        .update(botAutomationRuns)
        .set({ status: terminalStatus, updatedAt: now, finishedAt: terminalAt })
        .where(eq(botAutomationRuns.id, row.id));
    }
    if (row.sessionId) {
      await db
        .update(botSessionLinks)
        .set({ role: 'history', channelId: null, routeKey: null, archivedAt: terminalAt })
        .where(eq(botSessionLinks.sessionId, row.sessionId));
      if (row.sessionStatus === 'active') {
        await (deps.archiveSession?.(row.sessionId) ?? db
          .update(sessions)
          .set({ status: 'archived', updatedAt: terminalAt })
          .where(eq(sessions.id, row.sessionId))
          .then(() => undefined)).catch((error) => {
          deps.logger?.warn?.('[bot-automation] reconcile archive failed', {
            automationRunId: row.id,
            sessionId: row.sessionId,
            error: errorText(error),
          });
        });
      }
      await deps.maker.closeSession(row.sessionId).catch((error) => {
        deps.logger?.warn?.('[bot-automation] reconcile runtime close failed', {
          automationRunId: row.id,
          sessionId: row.sessionId,
          error: errorText(error),
        });
      });
      schedulePerTaskWorkspaceReclaim(row.sessionId);
    }
  }
}
