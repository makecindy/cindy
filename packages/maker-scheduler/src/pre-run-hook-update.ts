import type { CreateScheduleInput, Schedule, UpdateScheduleInput } from './types.js';

/** Resolve the authoritative workdir of a bound scheduler session. */
export type ResolveScheduleSessionWorkDir = (sessionId: string) => Promise<string | undefined>;

/** Convert a supported hook command into a cwd-independent representation. */
export type StabilizeScheduleHookCommand = (input: {
  command: string;
  workingDir?: string;
}) => Promise<string>;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function resolveEffectiveWorkingDir(
  targetSessionId: string | undefined,
  workingDir: string | undefined,
  resolveSessionWorkDir: ResolveScheduleSessionWorkDir,
): Promise<string | undefined> {
  if (targetSessionId?.trim()) {
    const sessionDir = await resolveSessionWorkDir(targetSessionId).catch(() => undefined);
    if (sessionDir?.trim()) return sessionDir;
  }
  return workingDir?.trim() || undefined;
}

/**
 * Stabilize a create input's single-file pre-run hook before it is persisted.
 * Arbitrary shell commands remain untouched by the injected stabilizer.
 */
export async function stabilizePreRunHookForCreate(
  input: CreateScheduleInput,
  deps: {
    resolveSessionWorkDir: ResolveScheduleSessionWorkDir;
    stabilizeCommand: StabilizeScheduleHookCommand;
  },
): Promise<CreateScheduleInput> {
  if (!input.preRunHook?.command?.trim()) return input;
  const workingDir = await resolveEffectiveWorkingDir(
    input.executionMode === 'script' ? undefined : input.targetSessionId,
    input.workingDir,
    deps.resolveSessionWorkDir,
  );
  const command = await deps.stabilizeCommand({
    command: input.preRunHook.command,
    workingDir,
  });
  if (command === input.preRunHook.command) return input;
  return { ...input, preRunHook: { ...input.preRunHook, command } };
}

/**
 * Stabilize a schedule update without changing hook execution cwd semantics.
 *
 * An unchanged relative command belongs to the pre-update workdir, so it is
 * resolved there before a session/workdir rebind. A newly supplied command is
 * resolved against the post-update workdir instead.
 */
export async function stabilizePreRunHookForUpdate(
  existing: Schedule,
  patch: UpdateScheduleInput,
  deps: {
    resolveSessionWorkDir: ResolveScheduleSessionWorkDir;
    stabilizeCommand: StabilizeScheduleHookCommand;
  },
): Promise<UpdateScheduleInput> {
  const patchHasHook = hasOwn(patch, 'preRunHook');
  if (patchHasHook && patch.preRunHook == null) return patch;

  const nextHook = patchHasHook ? patch.preRunHook : existing.preRunHook;
  if (!nextHook?.command?.trim()) return patch;

  const nextTargetSessionId = hasOwn(patch, 'targetSessionId')
    ? patch.targetSessionId
    : existing.targetSessionId;
  const nextWorkingDir = hasOwn(patch, 'workingDir') ? patch.workingDir : existing.workingDir;
  const commandChanged = patchHasHook && nextHook.command !== existing.preRunHook?.command;
  const workingDir = commandChanged
    ? await resolveEffectiveWorkingDir(
        (patch.executionMode ?? existing.executionMode) === 'script' ? undefined : nextTargetSessionId,
        nextWorkingDir,
        deps.resolveSessionWorkDir,
      )
    : await resolveEffectiveWorkingDir(
        existing.executionMode === 'script' ? undefined : existing.targetSessionId,
        existing.workingDir,
        deps.resolveSessionWorkDir,
      );
  const command = await deps.stabilizeCommand({
    command: nextHook.command,
    workingDir,
  });
  if (command === nextHook.command) return patch;
  return { ...patch, preRunHook: { ...nextHook, command } };
}
