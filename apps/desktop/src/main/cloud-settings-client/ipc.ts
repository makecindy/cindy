import { z } from 'zod';
import { cloudLoginHandleSchema, cloudLoginDispatchSchema } from '../../shared/cloudInstanceLogin';
import {
  cloudInstanceTargetSchema,
  cloudInstancePowerSchema,
  cloudInstancePolicySchema,
  cloudInstanceUpgradeSchema,
} from '../../shared/cloudInstanceControl';
import {
  cloudClientHandleSchema,
  cloudClientReadSchema,
  cloudClientSaveSchema,
  cloudClientReceiptSchema,
  cloudClientManageSchema,
} from '../../shared/cloudSettingsClient';
import { throwIpcError } from '../utils/ipcValidate';
import { CloudClientError } from './transport';
import type { CloudClientCaller, createCloudSettingsService } from './service';

/** Thin, injectable IPC handlers; the Electron adapter supplies the trusted caller. */
export function cloudSettingsClientHandlers(
  service: ReturnType<typeof createCloudSettingsService>,
) {
  function handler<S extends z.core.$ZodType, R>(
    schema: S,
    run: (caller: CloudClientCaller, input: z.output<S>) => Promise<R>,
  ) {
    return async (caller: CloudClientCaller, raw: unknown): Promise<R> => {
      caller.assertCurrent();
      const input = z.safeParse(schema, raw);
      if (!input.success) throwIpcError('INVALID_PARAMS', 'Invalid cloud settings request');
      try {
        return await run(caller, input.data);
      } catch (error) {
        if (error instanceof CloudClientError) throwIpcError(error.code, error.code);
        throwIpcError('CLOUD_SETTINGS_UNAVAILABLE', 'Cloud settings request failed');
      }
    };
  }
  return {
    instanceAccess: handler(z.strictObject({}), (c) => service.instanceAccess(c)),
    instanceList: handler(z.strictObject({}), (c) => service.instanceList(c)),
    instanceCapacity: handler(z.strictObject({}), (c) => service.instanceCapacity(c)),
    instanceClaim: handler(z.strictObject({ another: z.literal(true).optional() }), (c, v) =>
      service.instanceClaim(c, v.another === true),
    ),
    instanceInitialize: handler(cloudInstanceTargetSchema, (c, v) =>
      service.instanceInitialize(c, v.deviceId),
    ),
    instanceLoginStart: handler(cloudInstanceTargetSchema, (c, v) => service.instanceLoginStart(c, v.deviceId)),
    instanceLoginDispatch: handler(cloudLoginDispatchSchema, (c, v) => service.instanceLoginDispatch(c, v.handle, v.action)),
    instanceLoginPoll: handler(cloudLoginHandleSchema, (c, v) => service.instanceLoginPoll(c, v.handle)),
    instanceLoginClose: handler(cloudLoginHandleSchema, (c, v) => service.instanceLoginClose(c, v.handle)),
    instanceRead: handler(cloudInstanceTargetSchema, (c, v) => service.instanceRead(c, v.deviceId)),
    instanceUpgrade: handler(cloudInstanceUpgradeSchema, (c, v) =>
      service.instanceUpgrade(c, v.deviceId, v.requestId),
    ),
    instancePower: handler(cloudInstancePowerSchema, (c, v) =>
      service.instancePower(c, v.deviceId, v.action),
    ),
    instancePolicy: handler(cloudInstancePolicySchema, (c, v) =>
      service.instancePolicy(c, v.deviceId, v.change),
    ),
    open: handler(z.strictObject({ deviceId: z.string().min(1).max(160) }), (c, v) =>
      service.open(c, v.deviceId),
    ),
    read: handler(cloudClientReadSchema, (c, v) => service.read(c, v.handle, v.domains)),
    save: handler(cloudClientSaveSchema, (c, v) => service.save(c, v.handle, v.change)),
    receipt: handler(cloudClientReceiptSchema, (c, v) =>
      service.receipt(c, v.handle, v.operationId),
    ),
    manage: handler(cloudClientManageSchema, (c, v) => service.manage(c, v.handle, v.command)),
    cancelAuthorizations: handler(cloudClientHandleSchema, (c, v) =>
      service.cancelAuthorizations(c, v.handle),
    ),
    close: handler(cloudClientHandleSchema, (c, v) => service.close(c, v.handle)),
  };
}
