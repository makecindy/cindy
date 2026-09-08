import type { AgentKind, UnifiedCommand } from '@cindy/maker-core';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { ensureMakeTask, startMakeDoctorInStream } from './cindyMakeDoctorStream';

export type CindyMakeInvocation =
  { command: 'cindy-make'; request: string } | { command: 'cindy-make-doctor' };

type MakeCommandMatch =
  | { kind: 'none' }
  | { kind: 'loading'; command: CindyMakeInvocation['command'] }
  | { kind: 'usage'; command: 'cindy-make-doctor' | 'cindy-make' }
  | { kind: 'start'; invocation: CindyMakeInvocation };

/** Explicit commands only; the merged roster retains same-name Skill precedence. */
export function classifyCindyMakeCommand(
  text: string,
  commands: readonly UnifiedCommand[] | null,
): MakeCommandMatch {
  const match = /^\/(cindy-make(?:-doctor)?)(?:\s([\s\S]*))?$/i.exec(text);
  if (!match) return { kind: 'none' };
  const name = match[1].toLowerCase() as CindyMakeInvocation['command'];
  const command = commands?.find((item) => item.name.toLowerCase() === name);
  if (!command) return { kind: 'loading', command: name };
  if (command.kind !== 'desktop') return { kind: 'none' };
  if (name === 'cindy-make-doctor') {
    return match[2]?.trim()
      ? { kind: 'usage', command: name }
      : { kind: 'start', invocation: { command: name } };
  }
  if (!match[2]?.trim()) return { kind: 'usage', command: name };
  return {
    kind: 'start',
    invocation: { command: name, request: match[2] },
  };
}

export interface CindyMakeCommandInput {
  text: string;
  commands: UnifiedCommand[] | null;
  sessionId?: string;
  remoteHostId?: string | null;
  /** null is confirmed local; undefined is unresolved ownership. */
  deviceId?: string | null;
  hasUnsupportedContent: boolean;
  /** Includes both the source composer and the account captured at click time. */
  isCurrent: () => boolean;
  createOptions: Parameters<typeof ensureMakeTask>[0]['createOptions'];
  /** Used only to preserve Pi's live same-name Skill ownership, never to start an Agent. */
  agentKind?: AgentKind | null;
  workingDir?: string | null;
}

type MakeCommandResult =
  | { kind: 'none' | 'stale' | 'failed' }
  | { kind: 'blocked'; messageKey: string }
  | { kind: 'started'; sessionId: string };

/** Native entry shared by home and existing-task composers, before model/send gates. */
export async function tryStartCindyMakeCommand(
  input: CindyMakeCommandInput,
): Promise<MakeCommandResult> {
  let match = classifyCindyMakeCommand(input.text, input.commands);
  if (match.kind === 'none') return { kind: 'none' };
  const owner = getDataOwnerGeneration();
  const isCurrent = () => isDataOwnerGenerationCurrent(owner) && input.isCurrent();
  if (!isCurrent()) return { kind: 'stale' };
  try {
    // A Pi project Skill can finish loading after the palette snapshot. Reuse the
    // ordinary command ownership reconciliation without preparing an Agent runtime.
    if (input.agentKind === 'pi' && input.sessionId && input.deviceId !== undefined) {
      const { loadAllCommands, reconcilePiRuntimeCommandForDispatchWithRetry } =
        await import('./slashCommands');
      if (!isCurrent()) return { kind: 'stale' };
      const name = match.kind === 'start' ? match.invocation.command : match.command;
      const { commands } = await reconcilePiRuntimeCommandForDispatchWithRetry({
        agentKind: 'pi',
        sessionId: input.sessionId,
        commandName: name,
        commands: input.commands ?? [],
        reload: () =>
          isCurrent()
            ? loadAllCommands(
                'pi',
                input.workingDir,
                {
                  sessionId: input.sessionId,
                  skipAgentSkills: !!input.remoteHostId,
                  forceReload: true,
                },
                input.deviceId ?? undefined,
              )
            : Promise.resolve([]),
      });
      if (!isCurrent()) return { kind: 'stale' };
      match = classifyCindyMakeCommand(input.text, commands);
      if (match.kind === 'none') return { kind: 'none' };
    }
    if (match.kind === 'loading') {
      return { kind: 'blocked', messageKey: 'cindyMakeDoctor.commandUnavailable' };
    }
    const command = match.kind === 'start' ? match.invocation.command : match.command;
    const copy = command === 'cindy-make' ? 'cindyMake' : 'cindyMakeDoctor';
    if (match.kind === 'usage' || input.hasUnsupportedContent) {
      return { kind: 'blocked', messageKey: `${copy}.usage` };
    }
    if (input.remoteHostId || input.deviceId !== null) {
      return { kind: 'blocked', messageKey: `${copy}.localOnly` };
    }
    const sessionId = await ensureMakeTask({
      sessionId: input.sessionId,
      createOptions: input.createOptions,
      isCurrent,
    });
    if (!sessionId || !isCurrent()) return { kind: 'stale' };
    return startMakeDoctorInStream(sessionId, match.invocation)
      ? { kind: 'started', sessionId }
      : { kind: 'failed' };
  } catch {
    return { kind: isCurrent() ? 'failed' : 'stale' };
  }
}
