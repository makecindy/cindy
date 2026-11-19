import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseProviderSharePeer } from '@cindy/device-link';

import { ownerScopedUserDataPath } from '../../appSessionState.js';
import { withCrossProcessLock } from '../../device-link/crossProcessLock.js';

export interface AgentNetStandbyPlacement {
  shareId: string;
  memberId: string;
  ownerDeviceId: string;
  target: string;
  admissionId: string;
}

const LOCATION_UNAVAILABLE = '[REMOTE_AGENT_UNAVAILABLE] Shared standby task location is unavailable';
const MAX_PLACEMENT_BYTES = 4096;

function placementPath(shareId: string, sessionId: string): string {
  const key = createHash('sha256').update(JSON.stringify([shareId, sessionId])).digest('hex');
  return ownerScopedUserDataPath('agent-net-standby-placements', key + '.json');
}

async function readPlacement(file: string, shareId: string): Promise<AgentNetStandbyPlacement | undefined> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_PLACEMENT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead > MAX_PLACEMENT_BYTES) throw new Error(LOCATION_UNAVAILABLE);
      const value = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as Partial<AgentNetStandbyPlacement> | null;
      const target = typeof value?.target === 'string' ? parseProviderSharePeer(value.target) : null;
      if (!value || value.shareId !== shareId || typeof value.memberId !== 'string' || typeof value.ownerDeviceId !== 'string'
        || typeof value.admissionId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.admissionId)
        || target?.role !== 'host' || target.shareId !== shareId) throw new Error(LOCATION_UNAVAILABLE);
      return value as AgentNetStandbyPlacement;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(LOCATION_UNAVAILABLE, { cause: error });
  }
}

/** A task with an uncertain or successful open must keep its original native history location. */
export function readAgentNetStandbyPlacement(shareId: string, sessionId: string): Promise<AgentNetStandbyPlacement | undefined> {
  return readPlacement(placementPath(shareId, sessionId), shareId);
}

export async function rememberAgentNetStandbyPlacement(placement: AgentNetStandbyPlacement, sessionId: string,
  assertCurrent: () => void): Promise<void> {
  const { shareId, memberId, ownerDeviceId, target, admissionId } = placement;
  const file = placementPath(shareId, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withCrossProcessLock(file + '.lock', { label: 'agent-net-standby-placement' }, async ({ held }) => {
    if (!held) throw new Error(LOCATION_UNAVAILABLE);
    const previous = await readPlacement(file, shareId);
    assertCurrent();
    if (previous) {
      if (previous.target !== target || previous.memberId !== memberId || previous.ownerDeviceId !== ownerDeviceId
        || previous.admissionId !== admissionId) throw new Error('[REMOTE_AGENT_INVALID] The original shared standby executor is required');
      return;
    }
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify({ shareId, memberId, ownerDeviceId, target, admissionId }), { flag: 'wx', mode: 0o600 });
      assertCurrent();
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  });
  assertCurrent();
}

/** Clear only the exact reservation being released or replaced by an accepted handoff. */
export async function clearAgentNetStandbyPlacement(placement: AgentNetStandbyPlacement, sessionId: string,
  assertCurrent: () => void): Promise<void> {
  const file = placementPath(placement.shareId, sessionId);
  if (!await readPlacement(file, placement.shareId)) return;
  await withCrossProcessLock(file + '.lock', { label: 'agent-net-standby-placement' }, async ({ held }) => {
    if (!held) throw new Error(LOCATION_UNAVAILABLE);
    const previous = await readPlacement(file, placement.shareId);
    assertCurrent();
    if (previous?.admissionId === placement.admissionId && previous.target === placement.target) await fs.unlink(file);
  });
}
