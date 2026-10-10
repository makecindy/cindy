import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

/** Both idle and busy moves go through the host's durable move queue. Never predict its runtime cwd. */
export async function moveLocalTaskProject(
  sessionId: string,
  workingDir: string | null,
): Promise<void> {
  const owner = getDataOwnerGeneration();
  const result = await window.electronAPI.deviceLink.taskMigration(null, {
    action: 'move-project',
    sessionId,
    workingDir,
  });
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (result.projectMove?.sessionId !== sessionId) throw new Error('MIGRATION_FAILED');
  const beforeRead = sessionsStore.findById(sessionId);
  const row = await sessionService.get(sessionId, { fresh: true });
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (row.id !== sessionId) throw new Error('MIGRATION_FAILED');
  // An accepted/finished move push during GET is newer than the response snapshot.
  // Merge only project fields so this read cannot undo unrelated row updates.
  const current = sessionsStore.findById(sessionId);
  if (sameProjectState(beforeRead, current)) {
    sessionsStore.patchLocal(sessionId, {
      workingDir: row.workingDir,
      workspaceKind: row.workspaceKind,
      projectMoveTarget: row.projectMoveTarget ?? null,
    });
  }
  if (workingDir !== null) void recentWorkdirsStore.forceRefresh().catch(() => undefined);
}

function sameProjectState(a: Session | null, b: Session | null): boolean {
  return (
    a?.workingDir === b?.workingDir &&
    a?.workspaceKind === b?.workspaceKind &&
    a?.projectMoveTarget === b?.projectMoveTarget
  );
}
