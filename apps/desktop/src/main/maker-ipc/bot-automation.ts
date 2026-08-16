import { randomUUID } from 'node:crypto';

import { BrowserWindow, ipcMain } from 'electron';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AgentKind } from '@cindy/maker-core';
import type {
  CreateScheduleInput,
  PreRunHookConfig,
  Schedule,
  UpdateScheduleInput,
} from '@cindy/maker-scheduler';

import type {
  BotAutomation,
  BotAutomationDeliveryStatus,
  BotAutomationRun,
  CreateBotAutomationInput,
  UpdateBotAutomationInput,
} from '../../shared/botAutomation.js';
import {
  normalizeBotAutomationExecutionPolicy,
  parseBotAutomationExecutionPlan,
} from '../../shared/botAutomation.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  botAutomationLinks,
  botAutomationRuns,
  botDeliveryOutbox,
  botProfileVersions,
  botProfiles,
  botProjectBindings,
  botRoutes,
  botWorkspaceLeases,
  scheduleRuns,
  schedules,
} from '../localDb/schema.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import { awaitReadyWithTimeout } from './schedule.js';
import type { EnqueueBotDeliveryInput } from './botDeliveryOutboxService.js';
import { withBotAutomationMutationLock } from './botAutomationMutationLock.js';
import { parseBotOutputArtifacts } from '../../shared/botOutputArtifact.js';
import { parseBotDeliveryDiagnostic } from '../../shared/botDeliveryDiagnostic.js';

const log = createLogger('maker-ipc:bot-automation');
const MAX_TEXT = 12_000;

function broadcast(payload: { botId: string; automationId?: string; runId?: string }): void {
  tapWindowBroadcast(MAKER_PUSH.BOT_AUTOMATION_CHANGED, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_AUTOMATION_CHANGED, payload);
    } catch (error) {
      log.warn('Bot automation broadcast failed', { error: String(error) });
    }
  }
}

function readOptionalString(value: unknown, field: string, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', `${field} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throwIpcError('INVALID_PARAMS', `${field} is too long`);
  return text;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throwIpcError('INVALID_PARAMS', `${field} must be boolean`);
  return value;
}

function readInterval(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 60_000) {
    throwIpcError('INVALID_PARAMS', 'intervalMs must be at least 60000');
  }
  return Math.floor(value);
}

function readPreRunHook(value: unknown): PreRunHookConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const body = requireObject(value, 'preRunHook');
  const command = requireString(body.command, 'preRunHook.command').trim();
  if (!command || command.length > 8_000) {
    throwIpcError('INVALID_PARAMS', 'preRunHook.command is invalid');
  }
  const timeoutMs = body.timeoutMs;
  if (
    timeoutMs !== undefined
    && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throwIpcError('INVALID_PARAMS', 'preRunHook.timeoutMs must be a positive number');
  }
  return { command, ...(timeoutMs ? { timeoutMs: Math.floor(timeoutMs) } : {}) };
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function agentKindFor(config: Record<string, unknown>): AgentKind {
  return config.harness === 'codex'
    ? 'codex'
    : config.harness === 'pi'
      ? 'pi'
      : 'claude-code';
}

async function readBotAutomationPolicy(botId: string): Promise<{
  profileVersion: number;
  agentKind: AgentKind;
}> {
  const db = getDbClient().drizzle;
  const [profile] = await db
    .select()
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile || profile.status !== 'active') throwIpcError('NOT_FOUND', 'Bot is unavailable');
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, botId),
        eq(botProfileVersions.version, profile.currentVersion),
      ),
    )
    .limit(1);
  if (!version) throwIpcError('INTERNAL', 'Bot Profile version is unavailable');
  const config = parseConfig(version.capabilitiesJson);
  if (config.automation !== true) {
    throwIpcError('INVALID_PARAMS', 'Enable automation in the Bot Profile first');
  }
  if (config.permissions !== 'trusted') {
    throwIpcError('INVALID_PARAMS', 'Bot automations require trusted operations');
  }
  return { profileVersion: profile.currentVersion, agentKind: agentKindFor(config) };
}

async function validateTargets(input: {
  botId: string;
  projectBindingId?: string;
  targetRouteId?: string;
}): Promise<void> {
  const db = getDbClient().drizzle;
  if (input.projectBindingId) {
    const [binding] = await db
      .select({ id: botProjectBindings.id })
      .from(botProjectBindings)
      .where(
        and(
          eq(botProjectBindings.id, input.projectBindingId),
          eq(botProjectBindings.botId, input.botId),
          eq(botProjectBindings.status, 'active'),
        ),
      )
      .limit(1);
    if (!binding) throwIpcError('INVALID_PARAMS', 'Project binding does not belong to this Bot');
  }
  if (input.targetRouteId) {
    const [route] = await db
      .select({ id: botRoutes.id })
      .from(botRoutes)
      .where(and(eq(botRoutes.id, input.targetRouteId), eq(botRoutes.botId, input.botId)))
      .limit(1);
    if (!route) throwIpcError('INVALID_PARAMS', 'Delivery route does not belong to this Bot');
  }
}

function automationFromRows(
  link: typeof botAutomationLinks.$inferSelect,
  schedule: typeof schedules.$inferSelect | null,
  activeRunCount: number,
): BotAutomation {
  return {
    id: link.id,
    botId: link.botId,
    scheduleId: schedule?.id ?? undefined,
    name: schedule?.name ?? 'Archived automation',
    prompt: schedule?.prompt ?? '',
    cronExpr: schedule?.cronExpr ?? '0 0 * * *',
    timezone: schedule?.timezone ?? 'UTC',
    recurring: schedule?.recurring ?? false,
    manual: schedule?.manual ?? true,
    intervalMs: schedule?.intervalMs ?? undefined,
    preRunHook: schedule?.preRunHookCommand
      ? {
          command: schedule.preRunHookCommand,
          timeoutMs: schedule.preRunHookTimeoutMs ?? undefined,
        }
      : undefined,
    projectBindingId: link.projectBindingId ?? undefined,
    targetRouteId: link.targetRouteId ?? undefined,
    durableNoteNamespace: link.durableNoteNamespace ?? undefined,
    executionPolicy: normalizeBotAutomationExecutionPolicy(parseConfig(link.executionPolicyJson)),
    createdWithProfileVersion: link.createdWithProfileVersion,
    status: link.status,
    scheduleStatus: schedule?.status ?? undefined,
    nextFireAt: schedule?.nextFireAt ?? undefined,
    lastFiredAt: schedule?.lastFiredAt ?? undefined,
    lastFinishedAt: schedule?.lastFinishedAt ?? undefined,
    createdAt: link.createdAt,
    updatedAt: Math.max(link.updatedAt, schedule?.updatedAt ?? 0),
    activeRunCount,
  };
}

async function readAutomation(automationId: string): Promise<{
  link: typeof botAutomationLinks.$inferSelect;
  schedule: Schedule | null;
}> {
  const db = getDbClient().drizzle;
  const [link] = await db
    .select()
    .from(botAutomationLinks)
    .where(eq(botAutomationLinks.id, automationId))
    .limit(1);
  if (!link) throwIpcError('NOT_FOUND', 'Bot automation not found');
  const { scheduler } = await awaitReadyWithTimeout();
  const schedule = link.scheduleId ? await scheduler.get(link.scheduleId) : null;
  return { link, schedule };
}

function schedulePatchFromInput(input: UpdateBotAutomationInput): UpdateScheduleInput {
  const patch: UpdateScheduleInput = {};
  if (input.name !== undefined) patch.name = requireString(input.name, 'name').trim();
  if (input.prompt !== undefined) patch.prompt = requireString(input.prompt, 'prompt').trim();
  if (input.cronExpr !== undefined) patch.cronExpr = requireString(input.cronExpr, 'cronExpr').trim();
  if (input.timezone !== undefined) patch.timezone = requireString(input.timezone, 'timezone').trim();
  if (input.recurring !== undefined) patch.recurring = readBoolean(input.recurring, 'recurring', true);
  if (input.manual !== undefined) patch.manual = readBoolean(input.manual, 'manual', false);
  if (Object.prototype.hasOwnProperty.call(input, 'intervalMs')) {
    patch.intervalMs = readInterval(input.intervalMs);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'preRunHook')) {
    patch.preRunHook = readPreRunHook(input.preRunHook);
  }
  return patch;
}

function previousSchedulePatch(schedule: Schedule): UpdateScheduleInput {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone,
    recurring: schedule.recurring,
    manual: schedule.manual,
    intervalMs: schedule.intervalMs,
    preRunHook: schedule.preRunHook,
  };
}

function deliveryStatus(
  run: typeof botAutomationRuns.$inferSelect,
  outbox: typeof botDeliveryOutbox.$inferSelect | null,
): BotAutomationDeliveryStatus {
  if (outbox) return outbox.status;
  return run.deliveryStatus === 'queued' ? 'pending' : run.deliveryStatus;
}

export interface BotAutomationHandlerDeps {
  enqueueDelivery: (input: EnqueueBotDeliveryInput) => Promise<{ id: string }>;
  retryDelivery: (
    id: string,
    botId: string,
    opts?: { allowDuplicateRisk?: boolean },
  ) => Promise<{ id: string }>;
}

export function registerBotAutomationHandlers(deps: BotAutomationHandlerDeps): void {
  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATIONS_LIST, async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = requireString(rawBotId, 'botId');
    const db = getDbClient().drizzle;
    const links = await db
      .select()
      .from(botAutomationLinks)
      .where(eq(botAutomationLinks.botId, botId))
      .orderBy(desc(botAutomationLinks.updatedAt));
    if (links.length === 0) return [];
    const scheduleIds = links.flatMap((link) => link.scheduleId ? [link.scheduleId] : []);
    const scheduleRows = scheduleIds.length
      ? await db.select().from(schedules).where(inArray(schedules.id, scheduleIds))
      : [];
    const activeRuns = await db
      .select({ automationLinkId: botAutomationRuns.automationLinkId })
      .from(botAutomationRuns)
      .where(inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']));
    const counts = new Map<string, number>();
    for (const run of activeRuns) counts.set(run.automationLinkId, (counts.get(run.automationLinkId) ?? 0) + 1);
    const bySchedule = new Map(scheduleRows.map((row) => [row.id, row]));
    return links.map((link) => automationFromRows(
      link,
      link.scheduleId ? bySchedule.get(link.scheduleId) ?? null : null,
      counts.get(link.id) ?? 0,
    ));
  });

  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATION_CREATE, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'input') as unknown as CreateBotAutomationInput;
    const botId = requireString(body.botId, 'botId');
    const name = requireString(body.name, 'name').trim();
    const prompt = requireString(body.prompt, 'prompt').trim();
    const cronExpr = requireString(body.cronExpr, 'cronExpr').trim();
    const timezone = requireString(body.timezone, 'timezone').trim();
    if (!name || !prompt || !cronExpr || !timezone) {
      throwIpcError('INVALID_PARAMS', 'name, prompt, cronExpr and timezone are required');
    }
    const projectBindingId = readOptionalString(body.projectBindingId, 'projectBindingId', 128);
    const targetRouteId = readOptionalString(body.targetRouteId, 'targetRouteId', 128);
    const durableNoteNamespace = readOptionalString(
      body.durableNoteNamespace,
      'durableNoteNamespace',
      256,
    );
    const executionPolicy = normalizeBotAutomationExecutionPolicy(body.executionPolicy);
    const policy = await readBotAutomationPolicy(botId);
    await validateTargets({ botId, projectBindingId, targetRouteId });
    const { scheduler } = await awaitReadyWithTimeout();
    const createInput: CreateScheduleInput & { source: 'bot' } = {
      source: 'bot',
      name,
      prompt,
      kind: 'cron',
      cronExpr,
      timezone,
      recurring: readBoolean(body.recurring, 'recurring', true),
      manual: readBoolean(body.manual, 'manual', false),
      intervalMs: readInterval(body.intervalMs),
      agentKind: policy.agentKind,
      workspaceKind: projectBindingId ? 'project' : 'dialogue',
      useWorktree: false,
      persistentSession: false,
      silentWhenIdle: true,
      executionMode: 'agent',
      preRunHook: readPreRunHook(body.preRunHook),
      notify: { desktop: false, feishu: false, wecomGroup: false },
    };
    const schedule = await scheduler.create(createInput);
    const now = Date.now();
    const automationId = randomUUID();
    try {
      await getDbClient().drizzle.insert(botAutomationLinks).values({
        id: automationId,
        botId,
        scheduleId: schedule.id,
        projectBindingId: projectBindingId ?? null,
        targetRouteId: targetRouteId ?? null,
        createdWithProfileVersion: policy.profileVersion,
        durableNoteNamespace: durableNoteNamespace ?? null,
        executionPolicyJson: JSON.stringify(executionPolicy),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await scheduler.delete(schedule.id).catch((cleanupError) => {
        log.error('Bot automation create compensation failed', {
          scheduleId: schedule.id,
          error: String(cleanupError),
        });
      });
      throw error;
    }
    broadcast({ botId, automationId });
    const [row] = await getDbClient().drizzle
      .select()
      .from(botAutomationLinks)
      .where(eq(botAutomationLinks.id, automationId))
      .limit(1);
    return automationFromRows(row!, await getDbClient().drizzle
      .select()
      .from(schedules)
      .where(eq(schedules.id, schedule.id))
      .limit(1)
      .then((rows) => rows[0] ?? null), 0);
  });

  ipcMain.handle(
    MAKER_INVOKE.BOT_AUTOMATION_UPDATE,
    async (event, rawId: unknown, rawPatch: unknown) => {
      assertTrustedAppRendererEvent(event);
      const automationId = requireString(rawId, 'automationId');
      const patch = requireObject(rawPatch, 'patch') as unknown as UpdateBotAutomationInput;
      const initial = await readAutomation(automationId);
      if (!initial.schedule || !initial.link.scheduleId) {
        throwIpcError('NOT_FOUND', 'Automation schedule is missing');
      }
      return withBotAutomationMutationLock(initial.link.scheduleId, async () => {
      const { link, schedule } = await readAutomation(automationId);
      if (!schedule || !link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
      const [activeRun] = await getDbClient().drizzle
        .select({ id: botAutomationRuns.id })
        .from(botAutomationRuns)
        .where(
          and(
            eq(botAutomationRuns.automationLinkId, automationId),
            inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
          ),
        )
        .limit(1);
      if (activeRun) {
        throwIpcError('PRECONDITION_FAILED', 'Wait for the active Bot automation run to finish');
      }
      await readBotAutomationPolicy(link.botId);
      const projectBindingId = Object.prototype.hasOwnProperty.call(patch, 'projectBindingId')
        ? readOptionalString(patch.projectBindingId, 'projectBindingId', 128)
        : link.projectBindingId ?? undefined;
      const targetRouteId = Object.prototype.hasOwnProperty.call(patch, 'targetRouteId')
        ? readOptionalString(patch.targetRouteId, 'targetRouteId', 128)
        : link.targetRouteId ?? undefined;
      await validateTargets({ botId: link.botId, projectBindingId, targetRouteId });
      const durableNoteNamespace = Object.prototype.hasOwnProperty.call(patch, 'durableNoteNamespace')
        ? readOptionalString(patch.durableNoteNamespace, 'durableNoteNamespace', 256)
        : link.durableNoteNamespace ?? undefined;
      const executionPolicy = Object.prototype.hasOwnProperty.call(patch, 'executionPolicy')
        ? normalizeBotAutomationExecutionPolicy(patch.executionPolicy)
        : normalizeBotAutomationExecutionPolicy(parseConfig(link.executionPolicyJson));
      const schedulePatch = schedulePatchFromInput(patch);
      const { scheduler } = await awaitReadyWithTimeout();
      const updatedSchedule = Object.keys(schedulePatch).length > 0
        ? await scheduler.update(link.scheduleId, schedulePatch)
        : schedule;
      try {
        await getDbClient().drizzle
          .update(botAutomationLinks)
          .set({
            projectBindingId: projectBindingId ?? null,
            targetRouteId: targetRouteId ?? null,
            durableNoteNamespace: durableNoteNamespace ?? null,
            executionPolicyJson: JSON.stringify(executionPolicy),
            updatedAt: Date.now(),
          })
          .where(eq(botAutomationLinks.id, automationId));
      } catch (error) {
        if (Object.keys(schedulePatch).length > 0) {
          await scheduler.update(link.scheduleId, previousSchedulePatch(schedule)).catch((rollbackError) => {
            log.error('Bot automation update compensation failed', {
              automationId,
              error: String(rollbackError),
            });
          });
        }
        throw error;
      }
      broadcast({ botId: link.botId, automationId });
      const [updatedLink] = await getDbClient().drizzle
        .select()
        .from(botAutomationLinks)
        .where(eq(botAutomationLinks.id, automationId))
        .limit(1);
      return automationFromRows(updatedLink!, await getDbClient().drizzle
        .select()
        .from(schedules)
        .where(eq(schedules.id, updatedSchedule.id))
        .limit(1)
        .then((rows) => rows[0] ?? null), 0);
      });
    },
  );

  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATION_PAUSE, async (event, rawId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const automationId = requireString(rawId, 'automationId');
    const initial = await readAutomation(automationId);
    if (!initial.link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
    return withBotAutomationMutationLock(initial.link.scheduleId, async () => {
      const { link } = await readAutomation(automationId);
      if (!link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
      const db = getDbClient().drizzle;
      await db.update(botAutomationLinks).set({ status: 'paused', updatedAt: Date.now() })
        .where(eq(botAutomationLinks.id, automationId));
      try {
        const { scheduler } = await awaitReadyWithTimeout();
        await scheduler.pause(link.scheduleId);
      } catch (error) {
        await db.update(botAutomationLinks).set({ status: link.status, updatedAt: Date.now() })
          .where(eq(botAutomationLinks.id, automationId));
        throw error;
      }
      broadcast({ botId: link.botId, automationId });
    });
  });

  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATION_RESUME, async (event, rawId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const automationId = requireString(rawId, 'automationId');
    const initial = await readAutomation(automationId);
    if (!initial.link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
    return withBotAutomationMutationLock(initial.link.scheduleId, async () => {
      const { link } = await readAutomation(automationId);
      if (!link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
      await readBotAutomationPolicy(link.botId);
      const db = getDbClient().drizzle;
      await db.update(botAutomationLinks).set({ status: 'active', updatedAt: Date.now() })
        .where(eq(botAutomationLinks.id, automationId));
      try {
        const { scheduler } = await awaitReadyWithTimeout();
        await scheduler.resume(link.scheduleId);
      } catch (error) {
        await db.update(botAutomationLinks).set({ status: link.status, updatedAt: Date.now() })
          .where(eq(botAutomationLinks.id, automationId));
        throw error;
      }
      broadcast({ botId: link.botId, automationId });
    });
  });

  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATION_RUN_NOW, async (event, rawId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const automationId = requireString(rawId, 'automationId');
    const { link } = await readAutomation(automationId);
    if (link.status !== 'active' || !link.scheduleId) {
      throwIpcError('INVALID_PARAMS', 'Resume this Bot automation before running it');
    }
    await readBotAutomationPolicy(link.botId);
    const { scheduler } = await awaitReadyWithTimeout();
    const result = await scheduler.runNow(link.scheduleId);
    broadcast({ botId: link.botId, automationId, runId: result.runId });
    return result;
  });

  ipcMain.handle(MAKER_INVOKE.BOT_AUTOMATION_DELETE, async (event, rawId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const automationId = requireString(rawId, 'automationId');
    const initial = await readAutomation(automationId);
    if (!initial.link.scheduleId) throwIpcError('NOT_FOUND', 'Automation schedule is missing');
    return withBotAutomationMutationLock(initial.link.scheduleId, async () => {
    const { link } = await readAutomation(automationId);
    const db = getDbClient().drizzle;
    const [activeRun] = await db
      .select({ id: botAutomationRuns.id })
      .from(botAutomationRuns)
      .where(
        and(
          eq(botAutomationRuns.automationLinkId, automationId),
          inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
        ),
      )
      .limit(1);
    if (activeRun) {
      throwIpcError('PRECONDITION_FAILED', 'Wait for the active Bot automation run to finish');
    }
    await db.update(botAutomationLinks).set({ status: 'archived', updatedAt: Date.now() })
      .where(eq(botAutomationLinks.id, automationId));
    try {
      if (link.scheduleId) {
        const { scheduler } = await awaitReadyWithTimeout();
        await scheduler.pause(link.scheduleId);
      }
    } catch (error) {
      await db.update(botAutomationLinks).set({ status: link.status, updatedAt: Date.now() })
        .where(eq(botAutomationLinks.id, automationId));
      throw error;
    }
    // Archive instead of deleting the Scheduler row: schedule_runs contain the
    // result/error history that Bot users must still be able to inspect.
    broadcast({ botId: link.botId, automationId });
    });
  });

  ipcMain.handle(
    MAKER_INVOKE.BOT_AUTOMATION_LIST_RUNS,
    async (event, rawId: unknown, rawLimit: unknown) => {
      assertTrustedAppRendererEvent(event);
      const automationId = requireString(rawId, 'automationId');
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
        : 50;
      const { link } = await readAutomation(automationId);
      const db = getDbClient().drizzle;
      const rows = await db
        .select({
          run: botAutomationRuns,
          scheduleRun: scheduleRuns,
          outbox: botDeliveryOutbox,
          lease: botWorkspaceLeases,
        })
        .from(botAutomationRuns)
        .leftJoin(scheduleRuns, eq(scheduleRuns.id, botAutomationRuns.scheduleRunId))
        .leftJoin(botDeliveryOutbox, eq(botDeliveryOutbox.id, botAutomationRuns.deliveryOutboxId))
        .leftJoin(botWorkspaceLeases, eq(botWorkspaceLeases.id, botAutomationRuns.workspaceLeaseId))
        .where(eq(botAutomationRuns.automationLinkId, automationId))
        .orderBy(desc(botAutomationRuns.createdAt))
        .limit(limit);
      return rows.map(({ run, scheduleRun, outbox, lease }): BotAutomationRun => ({
        id: run.id,
        automationLinkId: run.automationLinkId,
        scheduleRunId: run.scheduleRunId ?? undefined,
        sessionId: run.sessionId ?? undefined,
        workspaceLeaseId: run.workspaceLeaseId ?? undefined,
        worktreePath: run.worktreePathSnapshot ?? lease?.worktreePath ?? undefined,
        profileVersion: run.profileVersion,
        executionPlan: parseBotAutomationExecutionPlan(run.executionPlanJson) ?? undefined,
        projectBindingId: run.projectBindingIdSnapshot ?? undefined,
        targetRouteId: run.targetRouteIdSnapshot ?? undefined,
        workingDir: run.workingDirSnapshot ?? undefined,
        remoteHostId: run.remoteHostIdSnapshot ?? undefined,
        status: run.status,
        scheduleStatus: scheduleRun?.status ?? undefined,
        resultText: scheduleRun?.resultText ?? run.resultTextSnapshot ?? undefined,
        outputArtifacts: parseBotOutputArtifacts(run.outputArtifactsJson),
        errorMessage: run.errorMessage ?? scheduleRun?.errorMsg ?? undefined,
        deliveryOutboxId: run.deliveryOutboxId ?? undefined,
        deliveryStatus: deliveryStatus(run, outbox),
        deliveryError: outbox?.lastError ?? run.deliveryError ?? undefined,
        deliveryDiagnostic: parseBotDeliveryDiagnostic(outbox?.deliveryReceiptJson),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        firedAt: scheduleRun?.firedAt ?? undefined,
        finishedAt: run.finishedAt ?? scheduleRun?.finishedAt ?? undefined,
      }));
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.BOT_AUTOMATION_RETRY_DELIVERY,
    async (event, rawAutomationId: unknown, rawRunId: unknown, rawAllowDuplicateRisk: unknown) => {
      assertTrustedAppRendererEvent(event);
      const automationId = requireString(rawAutomationId, 'automationId');
      const runId = requireString(rawRunId, 'runId');
      const allowDuplicateRisk = rawAllowDuplicateRisk === true;
      const { link } = await readAutomation(automationId);
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({
          run: botAutomationRuns,
          scheduleRun: scheduleRuns,
          schedule: schedules,
        })
        .from(botAutomationRuns)
        .leftJoin(scheduleRuns, eq(scheduleRuns.id, botAutomationRuns.scheduleRunId))
        .leftJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
        .where(
          and(
            eq(botAutomationRuns.id, runId),
            eq(botAutomationRuns.automationLinkId, automationId),
          ),
        )
        .limit(1);
      if (!row) throwIpcError('NOT_FOUND', 'Bot automation run not found');
      if (row.run.status !== 'success') {
        throwIpcError('INVALID_PARAMS', 'Only a completed Bot automation can retry delivery');
      }
      const [activeProfile] = await db
        .select({
          status: botProfiles.status,
          canonicalSessionId: botProfiles.canonicalSessionId,
        })
        .from(botProfiles)
        .where(eq(botProfiles.id, link.botId))
        .limit(1);
      if (!activeProfile || activeProfile.status !== 'active') {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Restore the Bot before retrying an automation delivery',
        );
      }

      let outboxId = row.run.deliveryOutboxId;
      if (outboxId) {
        await deps.retryDelivery(outboxId, link.botId, { allowDuplicateRisk });
      } else {
        if (row.run.deliveryStatus !== 'enqueue-failed') {
          throwIpcError('INVALID_PARAMS', 'This Bot automation delivery cannot be retried');
        }
        if (!row.run.sessionId) {
          throwIpcError('PRECONDITION_FAILED', 'The completed Bot task is unavailable');
        }

        let target:
          | {
              sessionId: string;
              channelId: string | null;
              routeId: string | null;
              ownerGeneration: number;
            }
          | undefined;
        if (row.run.targetRouteIdSnapshot) {
          const [route] = await db
            .select({
              botId: botRoutes.botId,
              channelId: botRoutes.channelId,
              currentSessionId: botRoutes.currentSessionId,
              ownerGeneration: botRoutes.ownerGeneration,
              status: botRoutes.status,
            })
            .from(botRoutes)
            .where(eq(botRoutes.id, row.run.targetRouteIdSnapshot))
            .limit(1);
          if (
            !route
            || route.botId !== link.botId
            || route.status !== 'active'
            || !route.currentSessionId
          ) {
            throwIpcError('PRECONDITION_FAILED', 'The frozen Bot delivery route is unavailable');
          }
          if (row.run.targetRouteOwnerGenerationSnapshot === null) {
            throwIpcError(
              'PRECONDITION_FAILED',
              'The Bot delivery owner snapshot is unavailable; run the automation again',
            );
          }
          if (route.ownerGeneration !== row.run.targetRouteOwnerGenerationSnapshot) {
            throwIpcError(
              'PRECONDITION_FAILED',
              'The Bot delivery route ownership changed; the old result will not be redirected',
            );
          }
          target = {
            sessionId: route.currentSessionId,
            channelId: route.channelId,
            routeId: row.run.targetRouteIdSnapshot,
            ownerGeneration: route.ownerGeneration,
          };
        } else {
          if (!activeProfile.canonicalSessionId) {
            throwIpcError('PRECONDITION_FAILED', 'The Bot canonical task is unavailable');
          }
          target = {
            sessionId: activeProfile.canonicalSessionId,
            channelId: null,
            routeId: null,
            ownerGeneration: 0,
          };
        }

        const automationName = row.schedule?.name ?? 'Automation';
        const stableRunIdentity = row.run.scheduleRunId ?? row.run.id;
        const deliveryKey = `bot-automation-completion:${stableRunIdentity}`;
        const text = [
          `[Cindy Bot automation ${automationName} completed]`,
          (row.scheduleRun?.resultText ?? row.run.resultTextSnapshot)?.trim()
            ? `Result:\n${(row.scheduleRun?.resultText ?? row.run.resultTextSnapshot)!.trim()}`
            : '',
          `Run task: ${row.run.sessionId}`,
        ].filter(Boolean).join('\n\n');
        const delivery = await deps.enqueueDelivery({
          botId: link.botId,
          channelId: target.channelId,
          routeId: target.routeId,
          sessionId: target.sessionId,
          ownerGeneration: target.ownerGeneration,
          idempotencyKey: deliveryKey,
          payload: {
            version: 1,
            kind: 'session-message',
            targetSessionId: target.sessionId,
            fallbackBotId: link.botId,
            clientId: deliveryKey,
            message: text,
            persistedContent: text,
          },
        });
        outboxId = delivery.id;
      }

      await db
        .update(botAutomationRuns)
        .set({
          deliveryOutboxId: outboxId,
          deliveryStatus: 'queued',
          deliveryError: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(botAutomationRuns.id, runId),
            eq(botAutomationRuns.automationLinkId, automationId),
          ),
        );
      broadcast({ botId: link.botId, automationId, runId });
    },
  );
}
