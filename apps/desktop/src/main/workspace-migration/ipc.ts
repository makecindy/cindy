import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { teammateFolderName } from '@cindy/maker-shared/teammate-project';

import type {
  WorkspaceMigrationChooseTargetResult,
  WorkspaceMigrationScheduleInput,
  WorkspaceMigrationScheduleResult,
  WorkspaceMigrationStatus,
} from '../../shared/workspaceMigration.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  cancelWorkspaceMove,
  previewWorkspaceMove,
  requestWorkspaceMove,
  workspaceMoveStatus,
} from './service.js';

const GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_CANDIDATE_SUFFIX = 99;

export interface WorkspaceMigrationOwnerContext {
  ownerId: string;
  scopeKey: string;
  ownerRoot: string;
}

interface TargetGrant {
  ownerId: string;
  scopeKey: string;
  botId: string;
  target: string;
  expiresAt: number;
}

export interface WorkspaceMigrationIpcDeps {
  captureOwner(): WorkspaceMigrationOwnerContext | null;
  isOwnerCurrent(owner: WorkspaceMigrationOwnerContext): boolean;
  canSchedule(): boolean;
  assertLocalBuddy(botId: string): Promise<void>;
  selectTargetParentDirectory(): Promise<string | null>;
  relaunch(botId: string): void;
  now?: () => number;
}

function requireBotId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 200 || !teammateFolderName(raw)) {
    throwIpcError('INVALID_PARAMS', 'Invalid buddy id');
  }
  return raw;
}

async function deriveCandidateTarget(parentDir: string, botId: string): Promise<string> {
  const folderName = teammateFolderName(botId);
  if (!folderName) throwIpcError('INVALID_PARAMS', 'Invalid buddy id');
  const baseName = `${folderName}-workspace`;
  for (let suffix = 1; suffix <= MAX_CANDIDATE_SUFFIX; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const candidate = path.join(parentDir, name);
    const exists = await fs.lstat(candidate).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? false : true),
    );
    if (!exists) return candidate;
  }
  return path.join(parentDir, `${baseName}-${randomUUID().slice(0, 8)}`);
}

const KNOWN_PREVIEW_ERRORS = new Set([
  'ABSOLUTE_TARGET_REQUIRED',
  'LOCAL_DISK_REQUIRED',
  'TARGET_OVERLAPS_CINDY_DATA',
  'BOT_HOME_IS_REDIRECTED',
  'WORKSPACE_ALREADY_REDIRECTED',
  'TARGET_EXISTS',
  'INSUFFICIENT_SPACE',
  'UNSUPPORTED_FILE_OR_HARD_LINK',
  'DIRECTORY_CHANGED',
  'WORKSPACE_CHANGED',
]);

export function createWorkspaceMigrationIpcHandlers(deps: WorkspaceMigrationIpcDeps) {
  const grants = new Map<string, TargetGrant>();
  const now = () => (deps.now ?? Date.now)();

  const pruneExpiredGrants = () => {
    const current = now();
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= current) grants.delete(id);
    }
  };

  const captureReadyOwner = (): WorkspaceMigrationOwnerContext => {
    const owner = deps.captureOwner();
    if (!owner) throwIpcError('PRECONDITION_FAILED', 'Account session is not ready');
    return owner;
  };

  const assertOwnerCurrent = (owner: WorkspaceMigrationOwnerContext): void => {
    if (!deps.isOwnerCurrent(owner)) {
      throwIpcError('PRECONDITION_FAILED', 'Account session changed');
    }
  };

  const toPublicStatus = async (
    owner: WorkspaceMigrationOwnerContext,
    botId: string,
  ): Promise<WorkspaceMigrationStatus> => {
    const raw = await workspaceMoveStatus(owner.ownerRoot, botId);
    return {
      botId: raw.botId,
      source: raw.source,
      workspaceAvailable: raw.workspaceAvailable,
      startupWarning: raw.startupWarning,
      phase: raw.phase,
      target: raw.target,
      error: raw.error,
      backupRemaining: raw.backupRemaining,
      backup: raw.backup,
      canSchedule: deps.canSchedule(),
    };
  };

  return {
    async getStatus(rawBotId: unknown): Promise<WorkspaceMigrationStatus> {
      const botId = requireBotId(rawBotId);
      const owner = captureReadyOwner();
      await deps.assertLocalBuddy(botId);
      assertOwnerCurrent(owner);
      return toPublicStatus(owner, botId);
    },

    async chooseTarget(rawBotId: unknown): Promise<WorkspaceMigrationChooseTargetResult> {
      const botId = requireBotId(rawBotId);
      const owner = captureReadyOwner();
      await deps.assertLocalBuddy(botId);
      assertOwnerCurrent(owner);
      const parentDir = await deps.selectTargetParentDirectory();
      if (!parentDir) return { selected: false };
      assertOwnerCurrent(owner);
      const candidateTarget = await deriveCandidateTarget(parentDir, botId);
      try {
        const preview = await previewWorkspaceMove(owner.ownerRoot, botId, candidateTarget);
        assertOwnerCurrent(owner);
        pruneExpiredGrants();
        const grantId = randomUUID();
        grants.set(grantId, {
          ownerId: owner.ownerId,
          scopeKey: owner.scopeKey,
          botId,
          target: preview.target,
          expiresAt: now() + GRANT_TTL_MS,
        });
        return {
          selected: true,
          preview: {
            grantId,
            source: preview.source,
            target: preview.target,
            bytes: preview.bytes,
            files: preview.files,
            links: preview.links,
          },
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : 'WORKSPACE_MIGRATION_FAILED';
        if (KNOWN_PREVIEW_ERRORS.has(code)) {
          return { selected: true, errorCode: code, candidateTarget };
        }
        throw error;
      }
    },

    async schedule(rawInput: unknown): Promise<WorkspaceMigrationScheduleResult> {
      if (!rawInput || typeof rawInput !== 'object') {
        throwIpcError('INVALID_PARAMS', 'Schedule input is required');
      }
      const input = rawInput as Partial<WorkspaceMigrationScheduleInput>;
      const botId = requireBotId(input.botId);
      if (typeof input.grantId !== 'string' || !input.grantId) {
        throwIpcError('INVALID_PARAMS', 'A valid folder selection grant is required');
      }
      if (typeof input.restartNow !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'restartNow must be a boolean');
      }
      if (!deps.canSchedule()) {
        throwIpcError('PRECONDITION_FAILED', 'Workspace migration requires the primary host build');
      }
      const owner = captureReadyOwner();
      pruneExpiredGrants();
      const grant = grants.get(input.grantId);
      if (
        !grant ||
        grant.ownerId !== owner.ownerId ||
        grant.scopeKey !== owner.scopeKey ||
        grant.botId !== botId
      ) {
        throwIpcError('PRECONDITION_FAILED', 'Folder selection expired; choose a folder again');
      }
      await deps.assertLocalBuddy(botId);
      assertOwnerCurrent(owner);
      grants.delete(input.grantId);
      await requestWorkspaceMove(owner.ownerRoot, botId, grant.target, () =>
        assertOwnerCurrent(owner),
      );
      const status = await toPublicStatus(owner, botId);
      const relaunching = input.restartNow && status.phase === 'pending';
      if (relaunching) {
        deps.relaunch(botId);
      }
      return { status, relaunching };
    },

    async cancel(rawBotId: unknown): Promise<WorkspaceMigrationStatus> {
      const botId = requireBotId(rawBotId);
      const owner = captureReadyOwner();
      await deps.assertLocalBuddy(botId);
      assertOwnerCurrent(owner);
      await cancelWorkspaceMove(owner.ownerRoot, botId, () => assertOwnerCurrent(owner));
      return toPublicStatus(owner, botId);
    },

    async restartForPending(rawBotId: unknown): Promise<{ relaunching: boolean }> {
      const botId = requireBotId(rawBotId);
      if (!deps.canSchedule()) {
        throwIpcError('PRECONDITION_FAILED', 'Workspace migration requires the primary host build');
      }
      const owner = captureReadyOwner();
      await deps.assertLocalBuddy(botId);
      assertOwnerCurrent(owner);
      const status = await toPublicStatus(owner, botId);
      if (status.phase !== 'pending') {
        return { relaunching: false };
      }
      deps.relaunch(botId);
      return { relaunching: true };
    },
  };
}
