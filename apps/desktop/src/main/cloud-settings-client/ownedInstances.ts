import { z } from 'zod';
import {
  cloudInstanceViewSchema,
  cloudUpgradeStatusSchema,
} from '../../shared/cloudInstanceControl';
import { CloudClientError } from './transport';
import { cloudInstanceCapacitySchema, type CloudInstanceCapacity } from '../../shared/cloudSettingsClient';
export const cloudOwnedInstancesSchema = z.object({
  instances: z
    .array(
      z.object({
        instanceId: z.string().min(1).max(128),
        deviceId: z.string().min(1).max(160),
        customLabel: z.string().max(512).nullable(),
        nameSequence: z.number().int().nonnegative(),
        maintenanceUpgrade: cloudUpgradeStatusSchema.optional(),
        resourceChange: z
          .object({ phase: z.string().max(64) })
          .nullable()
          .optional(),
        status: z.object({
          instanceId: z.string(),
          deviceId: z.string(),
          desiredState: z.enum(['running', 'stopped', 'deleted']),
          runtimeState: z.string().max(64),
          image: z.string().max(2048),
          readiness: z.object({ ready: z.boolean() }),
          updateAvailable: z.boolean(),
          latestReleaseTag: z.string().max(256).nullable(),
          upgrade: z.object({ state: z.enum(['idle', 'verifying', 'rolled-back']) }),
          loginRequired: z.boolean().optional(),
          loginWakeSupported: z.boolean().optional(),
          ownership: z.object({ orgSlug: z.string().min(1).max(256).nullable() }).optional(),
          observedAtMs: z.number().nullable().optional(),
          updatedAtMs: z.number().optional(),
        }),
      }),
    )
    .max(1024),
});
export function parseCloud<S extends z.core.$ZodType>(schema: S, raw: unknown): z.output<S> {
  const value = z.safeParse(schema, raw);
  if (!value.success) throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  return value.data;
}

export type CloudOwnedInstance = z.infer<typeof cloudOwnedInstancesSchema>['instances'][number];
export function parseOwnedInstances(raw: unknown): CloudOwnedInstance[] {
  const list = parseCloud(cloudOwnedInstancesSchema, raw).instances;
  const ids = new Set<string>(),
    devices = new Set<string>();
  for (const v of list) {
    if (
      v.instanceId !== v.status.instanceId ||
      v.deviceId !== v.status.deviceId ||
      ids.has(v.instanceId) ||
      devices.has(v.deviceId)
    )
      throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
    ids.add(v.instanceId);
    devices.add(v.deviceId);
  }
  return list.filter((v) => v.status.desiredState !== 'deleted');
}
/** The owner's limit and use, when CIS reports them (older CIS does not). */
export function parseCapacity(raw: unknown): CloudInstanceCapacity | null {
  const value = z.object({ quota: cloudInstanceCapacitySchema }).safeParse(raw);
  return value.success ? value.data.quota : null;
}
export function projectOwnedInstances(raw: unknown) {
  const owned = parseOwnedInstances(raw);
  return owned.map((v) => projectCloudInstance(v, owned));
}
/** The default name numbers an instance among the owner's current instances, in claim
 * order. CIS nameSequence never shrinks after deletions, so it is not shown. A sole
 * instance gets no number, matching its device name. */
export function ownedInstanceOrdinal(
  owned: readonly CloudOwnedInstance[],
  target: CloudOwnedInstance,
): number | null {
  const live = owned
    .filter((v) => v.status.desiredState !== 'deleted')
    .sort((a, b) => a.nameSequence - b.nameSequence || (a.deviceId < b.deviceId ? -1 : 1));
  const index = live.findIndex((v) => v.deviceId === target.deviceId);
  return live.length < 2 || index < 0 ? null : index + 1;
}
export function projectCloudInstance(
  target: CloudOwnedInstance,
  owned: readonly CloudOwnedInstance[],
) {
  const status = target.status;
  const upgrade = target.maintenanceUpgrade;
  if (upgrade && upgrade.instanceId !== target.instanceId)
    throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  const tag = status.image.split('@')[0]!.split('/').at(-1)!.split(':').slice(1).join(':');
  return cloudInstanceViewSchema.parse({
    instanceId: target.instanceId,
    deviceId: target.deviceId,
    name: target.customLabel,
    nameSequence: target.nameSequence,
    ordinal: ownedInstanceOrdinal(owned, target),
    desiredState: status.desiredState,
    runtimeState: status.runtimeState,
    ready: status.readiness.ready,
    loginRequired: status.loginRequired === true,
    loginWakeSupported: status.loginWakeSupported === true,
    version: tag || null,
    imageId: /@sha256:([a-f0-9]{64})$/u.exec(status.image)?.[1] ?? null,
    updateAvailable: upgrade?.manualUpgrade ? upgrade.updateAvailable : status.updateAvailable,
    latestVersion: upgrade?.manualUpgrade ? upgrade.latestReleaseTag : status.latestReleaseTag,
    ...(upgrade
      ? { manualUpgrade: upgrade.manualUpgrade, upgradeOperation: upgrade.operation }
      : {}),
    resourceChanging:
      !!target.resourceChange &&
      (target.resourceChange.phase !== 'applied' ||
        (!status.loginRequired &&
          status.updatedAtMs !== undefined &&
          (status.observedAtMs == null || status.observedAtMs < status.updatedAtMs))),
    upgradeState: status.upgrade.state,
    observedAtMs: status.observedAtMs ?? null,
    maintenance: null,
  });
}
