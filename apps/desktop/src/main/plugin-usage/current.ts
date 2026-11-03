import os from 'node:os';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { PluginUsageService } from './service.js';
import { createPluginUsageReporting } from './reporting.js';

const log = createLogger('plugin-usage');
let current: { epoch: number; ownerKey: string; service: PluginUsageService } | null = null;
let closedEpoch: number | null = null;

/** A retained DbClient may use global rawDB; epoch checks cannot be replaced by reference capture. */
export function currentPluginUsageService(): PluginUsageService | null {
  const snapshot = getCurrentDbClientSnapshot();
  const ownerKey = activeOwnerScopeKey();
  if (
    !snapshot ||
    snapshot.clientEpoch === closedEpoch ||
    isAppSessionBoundaryPending() ||
    snapshot.userId !== getActiveAppSession().dataOwnerId
  )
    return null;
  if (current?.epoch === snapshot.clientEpoch && current.ownerKey === ownerKey)
    return current.service;
  if (current) void current.service.close();
  const service = new PluginUsageService({
    client: snapshot.client,
    deviceName: os.hostname(),
    reporting: createPluginUsageReporting(snapshot.userId),
    isCurrent: () => {
      const latest = getCurrentDbClientSnapshot();
      return (
        !isAppSessionBoundaryPending() &&
        latest?.client === snapshot.client &&
        latest.clientEpoch === snapshot.clientEpoch &&
        latest.userId === snapshot.userId &&
        activeOwnerScopeKey() === ownerKey
      );
    },
    warn: () => log.warn('plugin usage database operation unavailable'),
  });
  current = { epoch: snapshot.clientEpoch, ownerKey, service };
  return service;
}

export async function flushPluginUsageLifecycle(): Promise<void> {
  const closing = current;
  closedEpoch = getCurrentDbClientSnapshot()?.clientEpoch ?? null;
  current = null;
  await closing?.service.close();
}
