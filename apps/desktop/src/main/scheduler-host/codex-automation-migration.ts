import type {
  CreateScheduleInput,
  Schedule,
  Scheduler,
  UpdateScheduleInput,
} from '@cindy/maker-scheduler';

import {
  convertCodexAutomation,
  type CodexAutomationConversionResult,
} from './codex-automation-converter.js';
import type { CodexAutomationDetail, CodexAutomationReader } from './codex-automation-reader.js';

export type CodexAutomationMigrationConverter = (
  detail: CodexAutomationDetail,
) => CodexAutomationConversionResult;

export interface CodexAutomationMigrationScheduler {
  list(): Promise<Schedule[]>;
  create(input: CreateScheduleInput): Promise<Schedule>;
  update(id: string, patch: UpdateScheduleInput): Promise<Schedule>;
  pause(id: string): Promise<Schedule>;
  delete(id: string): Promise<void>;
}

export interface CodexAutomationMigrationPreviewItem {
  /** Alias retained for renderer list keys; sourceId is the explicit wire name. */
  id: string;
  sourceId: string;
  name: string;
  prompt: string;
  status: string;
  rrule: string;
  model?: string;
  reasoningEffort?: string;
  executionEnvironment?: string;
  target?: CodexAutomationDetail['target'];
  cwds: string[];
  sourcePath: string;
  diagnostics: string[];
  canImport: boolean;
  /** Convenience flag for renderer checkbox state; duplicateScheduleId carries the detail. */
  duplicate: boolean;
  duplicateScheduleId?: string;
  selectedByDefault: boolean;
  input?: CreateScheduleInput;
}

export interface CodexAutomationMigrationPreview {
  items: CodexAutomationMigrationPreviewItem[];
  total: number;
  eligibleCount: number;
  selectedCount: number;
}

export interface CodexAutomationImportResult {
  created: Array<{ sourceId: string; scheduleId: string; name: string }>;
  skipped: Array<{ sourceId: string; name?: string; reason: string; scheduleId?: string }>;
  failed: Array<{ sourceId: string; name?: string; error: string }>;
}

export interface CodexAutomationMigrationService {
  preview(): Promise<CodexAutomationMigrationPreview>;
  import(sourceIds: string[]): Promise<CodexAutomationImportResult>;
}

interface MigrationDeps {
  reader: CodexAutomationReader;
  scheduler: CodexAutomationMigrationScheduler;
  converter?: CodexAutomationMigrationConverter;
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim();
}

function uniqueDiagnostics(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function samePreRunHook(
  schedule: Schedule['preRunHook'],
  input: CreateScheduleInput['preRunHook'],
): boolean {
  const normalizedInput = input ?? undefined;
  if (!schedule || !normalizedInput) return schedule === normalizedInput;
  return (
    normalized(schedule.command) === normalized(normalizedInput.command) &&
    schedule.timeoutMs === normalizedInput.timeoutMs
  );
}

function sameScriptConfig(
  schedule: Schedule['scriptConfig'],
  input: CreateScheduleInput['scriptConfig'],
): boolean {
  const normalizedInput = input ?? undefined;
  if (!schedule || !normalizedInput) return schedule === normalizedInput;
  return (
    normalized(schedule.command) === normalized(normalizedInput.command) &&
    schedule.timeoutMs === normalizedInput.timeoutMs &&
    [...schedule.capabilities].sort().join(',') ===
      [...normalizedInput.capabilities].sort().join(',')
  );
}

let importTail: Promise<void> = Promise.resolve();

function withImportLock<T>(task: () => Promise<T>): Promise<T> {
  const run = importTail.then(task, task);
  importTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Determines whether an existing Cindy schedule has the same semantic payload
 * as a converted Codex automation. There is no source-id column on schedules,
 * so this deliberately compares the immutable execution fields used by the
 * importer. This also makes repeated imports idempotent without touching the
 * source TOMLs.
 */
export function findDuplicateSchedule(
  schedules: Schedule[],
  input: CreateScheduleInput,
): Schedule | undefined {
  return schedules.find((schedule) => {
    return (
      normalized(schedule.name) === normalized(input.name) &&
      normalized(schedule.prompt) === normalized(input.prompt) &&
      schedule.kind === input.kind &&
      normalized(schedule.cronExpr) === normalized(input.cronExpr) &&
      normalized(schedule.timezone) === normalized(input.timezone) &&
      schedule.recurring === input.recurring &&
      (schedule.manual ?? false) === (input.manual ?? false) &&
      schedule.intervalMs === input.intervalMs &&
      schedule.agentKind === input.agentKind &&
      normalized(schedule.model) === normalized(input.model) &&
      normalized(schedule.providerId) === normalized(input.providerId) &&
      normalized(schedule.effort) === normalized(input.effort) &&
      (schedule.fastMode ?? false) === (input.fastMode ?? false) &&
      schedule.workspaceKind === (input.workspaceKind ?? 'project') &&
      normalized(schedule.workingDir) === normalized(input.workingDir) &&
      schedule.useWorktree === input.useWorktree &&
      (schedule.executionMode ?? 'agent') === (input.executionMode ?? 'agent') &&
      sameScriptConfig(schedule.scriptConfig, input.scriptConfig) &&
      samePreRunHook(schedule.preRunHook, input.preRunHook) &&
      (schedule.persistentSession ?? false) === (input.persistentSession ?? false) &&
      (schedule.silentWhenIdle ?? false) === (input.silentWhenIdle ?? false) &&
      schedule.expireAt === input.expireAt &&
      schedule.notify.desktop === input.notify.desktop &&
      schedule.notify.feishu === input.notify.feishu &&
      (schedule.notify.wecomGroup ?? false) === (input.notify.wecomGroup ?? false)
    );
  });
}

function toPreviewItem(
  detail: CodexAutomationDetail,
  converted: CodexAutomationConversionResult,
  duplicateScheduleId?: string,
): CodexAutomationMigrationPreviewItem {
  const diagnostics = uniqueDiagnostics(detail.diagnostics, converted.diagnostics);
  const canImport = converted.canImport && converted.input !== undefined;
  const selectedByDefault = canImport && duplicateScheduleId === undefined;
  return {
    id: detail.id,
    sourceId: detail.id,
    name: detail.name,
    prompt: detail.prompt,
    status: detail.status,
    rrule: detail.rrule,
    model: detail.model,
    reasoningEffort: detail.reasoningEffort,
    executionEnvironment: detail.executionEnvironment,
    target: detail.target,
    cwds: detail.cwds,
    sourcePath: detail.sourcePath,
    diagnostics,
    canImport,
    duplicate: duplicateScheduleId !== undefined,
    ...(duplicateScheduleId ? { duplicateScheduleId } : {}),
    selectedByDefault,
    ...(converted.input ? { input: converted.input } : {}),
  };
}

export function createCodexAutomationMigrationService(
  deps: MigrationDeps,
): CodexAutomationMigrationService {
  const converter = deps.converter ?? convertCodexAutomation;

  async function buildPreview(
    details: CodexAutomationDetail[],
    schedules: Schedule[],
  ): Promise<CodexAutomationMigrationPreview> {
    const items = details.map((detail) => {
      const converted = converter(detail);
      const duplicate = converted.input
        ? findDuplicateSchedule(schedules, converted.input)
        : undefined;
      return toPreviewItem(detail, converted, duplicate?.id);
    });
    return {
      items,
      total: items.length,
      eligibleCount: items.filter((item) => item.canImport).length,
      selectedCount: items.filter((item) => item.selectedByDefault).length,
    };
  }

  return {
    async preview(): Promise<CodexAutomationMigrationPreview> {
      const [details, schedules] = await Promise.all([deps.reader.list(), deps.scheduler.list()]);
      return buildPreview(details, schedules);
    },

    async import(sourceIds: string[]): Promise<CodexAutomationImportResult> {
      return withImportLock(async () => {
        const requestedIds = Array.from(
          new Set(
            sourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
          ),
        );
        const [details, schedules] = await Promise.all([deps.reader.list(), deps.scheduler.list()]);
        const byId = new Map(details.map((detail) => [detail.id, detail]));
        const created: CodexAutomationImportResult['created'] = [];
        const skipped: CodexAutomationImportResult['skipped'] = [];
        const failed: CodexAutomationImportResult['failed'] = [];
        const knownSchedules = [...schedules];

        for (const sourceId of requestedIds) {
          const detail = byId.get(sourceId);
          if (!detail) {
            failed.push({ sourceId, error: 'Codex automation not found' });
            continue;
          }
          let converted: CodexAutomationConversionResult;
          try {
            converted = converter(detail);
          } catch (error) {
            failed.push({
              sourceId,
              name: detail.name,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!converted.canImport || !converted.input) {
            skipped.push({
              sourceId,
              name: detail.name,
              reason:
                uniqueDiagnostics(detail.diagnostics, converted.diagnostics).join('; ') ||
                'Not importable',
            });
            continue;
          }
          const duplicate = findDuplicateSchedule(knownSchedules, converted.input);
          if (duplicate) {
            skipped.push({
              sourceId,
              name: detail.name,
              scheduleId: duplicate.id,
              reason: 'Equivalent Cindy schedule already exists',
            });
            continue;
          }
          let createdSchedule: Schedule | undefined;
          const desiredManual = converted.input.manual ?? false;
          const createInput: CreateScheduleInput =
            converted.status === 'paused' ? { ...converted.input, manual: true } : converted.input;
          try {
            // Paused Codex tasks are created in manual mode first. This is a
            // fail-closed staging state: even if both pause and delete fail,
            // the leftover schedule has no automatic next fire.
            createdSchedule = await deps.scheduler.create(createInput);
            let importedSchedule = createdSchedule;
            if (converted.status === 'paused' && createdSchedule.status === 'active') {
              importedSchedule = await deps.scheduler.pause(createdSchedule.id);
            }
            if (converted.status === 'paused' && importedSchedule.manual !== desiredManual) {
              importedSchedule = await deps.scheduler.update(importedSchedule.id, {
                manual: desiredManual,
              });
            }
            knownSchedules.push(importedSchedule);
            created.push({
              sourceId,
              scheduleId: importedSchedule.id,
              name: importedSchedule.name,
            });
          } catch (error) {
            let errorMessage = error instanceof Error ? error.message : String(error);
            if (createdSchedule) {
              try {
                await deps.scheduler.delete(createdSchedule.id);
              } catch (cleanupError) {
                const safetyState = createdSchedule.manual
                  ? `schedule ${createdSchedule.id} remains manual and will not auto-run`
                  : `schedule ${createdSchedule.id} may still be active`;
                errorMessage = `${errorMessage}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; ${safetyState}`;
              }
            }
            failed.push({
              sourceId,
              name: detail.name,
              error: errorMessage,
            });
          }
        }
        return { created, skipped, failed };
      });
    },
  };
}

/** Kept as a type-only assertion for consumers that already hold a Scheduler. */
export function asCodexAutomationMigrationScheduler(
  scheduler: Scheduler,
): CodexAutomationMigrationScheduler {
  return scheduler;
}
