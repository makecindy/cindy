import type { CloudInstanceView } from '../../../shared/cloudInstanceControl';

export const stableInstanceState = (view: CloudInstanceView) =>
  view.desiredState !== 'deleted' &&
  !view.upgradeOperation?.active &&
  !view.resourceChanging &&
  view.upgradeState !== 'verifying' &&
  ((view.desiredState === 'running' && view.runtimeState === 'running' && view.ready) ||
    (view.desiredState === 'stopped' && ['stopped', 'missing'].includes(view.runtimeState)) ||
    view.runtimeState === 'error');

// An unauthenticated runtime may be starting indefinitely until its owner signs in.
// Keep sleep available, without permitting changes during maintenance or resizing.
export const canChangeInstancePower = (view: CloudInstanceView) =>
  stableInstanceState(view) ||
  (view.loginRequired === true && view.desiredState === 'running' &&
    !view.upgradeOperation?.active && !view.resourceChanging && view.upgradeState !== 'verifying');

export const instanceStatus = (view: CloudInstanceView) =>
  view.upgradeOperation?.active || view.upgradeState === 'verifying'
    ? 'upgrading'
    : view.runtimeState === 'error'
      ? 'error'
      : view.desiredState === 'stopped'
        ? ['stopped', 'missing'].includes(view.runtimeState)
          ? 'asleep'
          : 'stopping'
        : view.runtimeState === 'running' && view.ready
          ? 'running'
          : 'starting';

const UPGRADE_ENDED_PHASES = new Set(['completed', 'cancelled', 'backup-deferred', 'recovery-hold']);
/**
 * CIS keeps its last runtime observation while an upgrade has the runtime down, so running/ready
 * can date from before the upgrade. Upgrading means CIS says so (an active operation or
 * verification), or DeviceLink does not have the instance while it should run and its last upgrade
 * operation is still under way or changed after CIS last observed the runtime.
 */
export const instanceUpgrading = (view: CloudInstanceView, linkOffline: boolean) => {
  if (instanceStatus(view) === 'upgrading') return true;
  const operation = view.upgradeOperation;
  return (
    linkOffline &&
    view.desiredState === 'running' &&
    !view.loginRequired &&
    !!operation &&
    (!UPGRADE_ENDED_PHASES.has(operation.phase) ||
      (view.observedAtMs !== null && operation.updatedAtMs > view.observedAtMs))
  );
};

// Match the owner's web action: one request outside the maintenance window is
// allowed even with auto-update off. CIS remains the final eligibility authority.
export const canRequestUpgrade = (view: CloudInstanceView) =>
  view.manualUpgrade === true &&
  view.updateAvailable &&
  !view.upgradeOperation?.active &&
  !view.resourceChanging &&
  !view.loginRequired &&
  view.upgradeState !== 'verifying' &&
  view.desiredState === 'running' &&
  view.runtimeState === 'running';

// The last upgrade record stays on the instance. Show an ended one only briefly; an active or
// held upgrade stays visible until it changes.
export const UPGRADE_NOTICE_MS = 30 * 60_000;
export const upgradeNoticeVisible = (
  operation: CloudInstanceView['upgradeOperation'],
  now = Date.now(),
) =>
  !!operation &&
  (operation.active ||
    operation.phase === 'recovery-hold' ||
    now - operation.updatedAtMs < UPGRADE_NOTICE_MS);

/**
 * Where the instance's last upgrade stands, as the update dialog and the card say it. Read from
 * CIS's operation phase and the instance's upgradeState; null when there is nothing to say about
 * an upgrade.
 * - queued: phase requested (waits for the running tasks)
 * - updating: any other active phase, or verifying; offline while DeviceLink does not have the
 *   instance (it restarts during the update), which is not an error
 * - done: phase completed
 * - failed: rolled-back (upgradeState), held (phase recovery-hold), or skipped (phase cancelled
 *   or backup-deferred)
 * Ended outcomes show for UPGRADE_NOTICE_MS; recovery-hold until it changes.
 */
export type UpgradeOutcome =
  | { kind: 'queued' | 'updating'; offline: boolean }
  | { kind: 'done' }
  | { kind: 'failed'; reason: 'skipped' | 'rolled-back' | 'held' };
export function upgradeOutcome(
  view: CloudInstanceView,
  linkOffline: boolean,
  now = Date.now(),
): UpgradeOutcome | null {
  const operation = view.upgradeOperation;
  if (instanceUpgrading(view, linkOffline))
    return {
      kind: operation?.active && operation.phase === 'requested' ? 'queued' : 'updating',
      offline: linkOffline,
    };
  if (!operation || !upgradeNoticeVisible(operation, now)) return null;
  if (view.upgradeState === 'rolled-back') return { kind: 'failed', reason: 'rolled-back' };
  // 语义待后端确认: whether a held instance is usable or stopped is not known here.
  if (operation.phase === 'recovery-hold') return { kind: 'failed', reason: 'held' };
  if (operation.phase === 'cancelled' || operation.phase === 'backup-deferred')
    return { kind: 'failed', reason: 'skipped' };
  if (operation.phase === 'completed') return { kind: 'done' };
  return null;
}
