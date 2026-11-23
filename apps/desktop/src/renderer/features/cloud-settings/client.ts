import {
  cloudInstanceViewSchema,
  cloudUpgradeOperationSchema,
  type CloudUpgradeOperation,
  cloudMaintenanceViewSchema,
  type CloudInstanceView,
  type CloudMaintenanceEdit,
  type CloudMaintenanceView,
} from '../../../shared/cloudInstanceControl';
import {
  cloudClientOpenSchema,
  type CloudClientOpen,
  type CloudSettingsRendererApi,
} from '../../../shared/cloudSettingsClient';
import {
  settingsWebResultSchema,
  settingsWebUpdateSchema,
  type SettingsWebResult,
} from '../../../shared/settingsWeb';
import {
  cloudSettingsStateSchema,
  cloudSettingsReadErrorCodeSchema,
  CLOUD_SETTINGS_DOMAINS,
  type CloudSettingsCapabilities,
  type CloudSettingsDomain,
  type CloudSettingsState,
} from '../../../shared/cloudSettings';
import type { ManagementCommand, ManagementResult } from '../../../shared/settingsManagement';
import { extractIpcError } from '@/utils/ipcError';

export interface CloudSettingsClient {
  instance?(): Promise<CloudInstanceView>;
  upgrade?(): Promise<CloudUpgradeOperation>;
  /**
   * An upgrade with an unknown result was read back and found started: the next request is a new
   * one. Until then a retry reuses the same request ID, so a late arrival cannot start a second.
   */
  upgradeSettled?(): void;
  power?(action: 'wake' | 'sleep'): Promise<void>;
  maintenance?(change: CloudMaintenanceEdit): Promise<CloudMaintenanceView>;
  manage?(command: ManagementCommand): Promise<ManagementResult>;
  connect(): Promise<CloudSettingsCapabilities>;
  reconnect(): Promise<CloudSettingsCapabilities>;
  read(domains: readonly CloudSettingsDomain[]): Promise<CloudSettingsState[]>;
  save(
    state: CloudSettingsState,
    set: Record<string, unknown>,
    clear?: string[],
  ): Promise<{ state: CloudSettingsState; application: string }>;
  cancelAuthorizations?(): void;
  close(): void;
}
function failure(error: unknown): Error {
  const parsed = extractIpcError(error);
  return new Error(
    parsed?.code?.startsWith('CLOUD_SETTINGS_') ? parsed.code : 'CLOUD_SETTINGS_UNAVAILABLE',
  );
}
function result(raw: SettingsWebResult): SettingsWebResult {
  const parsed = settingsWebResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error('CLOUD_SETTINGS_INVALID_RESPONSE');
  if (!parsed.data.ok)
    throw new Error(
      parsed.data.code === 'CONFLICT' ? 'CLOUD_SETTINGS_CONFLICT' : 'CLOUD_SETTINGS_UNAVAILABLE',
    );
  return parsed.data;
}

/** UI adapter only. Identity, target ownership and credentials live in Main. */
export function createCloudSettingsClient(
  deviceId: string,
  bridge: CloudSettingsRendererApi,
  assertOwner: () => void,
): CloudSettingsClient {
  let closed = false,
    writing = false,
    generation = 0;
  let upgradeRequestId: string | undefined;
  let session: CloudClientOpen | undefined,
    connecting: Promise<CloudSettingsCapabilities> | undefined;
  const check = () => {
    if (closed) throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
    assertOwner();
  };
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    check();
    const start = generation;
    let value: T;
    try {
      value = await run();
    } catch (error) {
      check();
      throw failure(error);
    }
    check();
    if (start !== generation) throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
    return value;
  };
  const project = (cap: CloudClientOpen): CloudSettingsCapabilities => ({
    version: 1,
    deviceId,
    runtimeId: cap.runtimeId,
    ownerGeneration: cap.ownerGeneration,
    domains: cap.domains.filter(
      (d): d is CloudSettingsDomain =>
        (CLOUD_SETTINGS_DOMAINS as string[]).includes(d) &&
        !['personalization', 'gitSafety'].includes(d),
    ),
    // Local view flags, not a new Host wire capability. Plugin launch remains unavailable.
    ...(cap.managementV1
      ? { providerAuthorization: 1, botAuthorization: 1, mcpAuthorization: 1 }
      : {}),
    ...(cap.resourceCpuCores ? { cpuCount: cap.resourceCpuCores } : {}),
  });
  const connect = (): Promise<CloudSettingsCapabilities> => {
    check();
    if (session) return Promise.resolve(project(session));
    if (connecting) return connecting;
    const start = generation;
    connecting = (async () => {
      let opened: CloudClientOpen | undefined;
      try {
        opened = cloudClientOpenSchema.parse(await bridge.open({ deviceId }));
        check();
        if (start !== generation || opened.deviceId !== deviceId)
          throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
        session = opened;
        return project(opened);
      } catch (error) {
        if (opened) void bridge.close({ handle: opened.handle }).catch(() => {});
        if (error instanceof Error && error.message === 'CLOUD_SETTINGS_SCOPE_CHANGED') throw error;
        throw failure(error);
      }
    })().finally(() => {
      if (start === generation) connecting = undefined;
    });
    return connecting;
  };
  const read = async (domains: readonly CloudSettingsDomain[]) => {
    const cap = await connect();
    check();
    if (domains.some((d) => !cap.domains.includes(d)))
      throw new Error('CLOUD_SETTINGS_UNSUPPORTED');
    if (!domains.length) return [];
    const responses = await call(() => bridge.read({ handle: session!.handle, domains }));
    if (responses.length !== domains.length) throw new Error('CLOUD_SETTINGS_INVALID_RESPONSE');
    return responses.map((raw, index) => {
      const parsed = settingsWebResultSchema.parse(raw);
      if (!parsed.ok && cloudSettingsReadErrorCodeSchema.safeParse(parsed.code).success)
        return cloudSettingsStateSchema.parse({
          domain: domains[index],
          status: 'unreadable',
          revision: null,
          readErrorCode: parsed.code,
        });
      const r = result(parsed);
      if (!r.ok || !('settings' in r) || r.settings.domain !== domains[index])
        throw new Error('CLOUD_SETTINGS_INVALID_RESPONSE');
      return cloudSettingsStateSchema.parse(r.settings);
    });
  };
  const manage = async (command: ManagementCommand): Promise<ManagementResult> => {
    await connect();
    check();
    if (
      !session!.managementV1 ||
      (command.operation === 'list' && !['providers', 'bots', 'mcp'].includes(command.section))
    )
      throw new Error('CLOUD_SETTINGS_UNSUPPORTED');
    const r = result(await call(() => bridge.manage({ handle: session!.handle, command })));
    if (!r.ok || !('management' in r)) throw new Error('CLOUD_SETTINGS_INVALID_RESPONSE');
    const m = r.management;
    if (
      command.operation === 'list'
        ? m.kind !== 'page' ||
          m.section !== command.section ||
          (m.offset ?? 0) !== (command.offset ?? 0)
        : m.kind !== 'operation' || m.operationId !== command.operationId
    )
      throw new Error('CLOUD_SETTINGS_INVALID_RESPONSE');
    return m;
  };
  return {
    async instance() {
      const value = cloudInstanceViewSchema.parse(
        await call(() => bridge.instanceRead({ deviceId })),
      );
      if (value.deviceId !== deviceId) throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
      return value;
    },
    async upgrade() {
      check();
      upgradeRequestId ??= crypto.randomUUID();
      const operation = cloudUpgradeOperationSchema.parse(
        await call(() => bridge.instanceUpgrade({ deviceId, requestId: upgradeRequestId! })),
      );
      upgradeRequestId = undefined;
      return operation;
    },
    upgradeSettled() {
      upgradeRequestId = undefined;
    },
    power: (action) => call(() => bridge.instancePower({ deviceId, action })),
    maintenance: async (change) =>
      cloudMaintenanceViewSchema.parse(
        await call(() => bridge.instancePolicy({ deviceId, change })),
      ),
    connect,
    read,
    manage,
    async reconnect() {
      check();
      if (writing) throw new Error('CLOUD_SETTINGS_NOT_READY');
      const old = session;
      generation++;
      session = undefined;
      connecting = undefined;
      if (old) await call(() => bridge.close({ handle: old.handle }));
      return connect();
    },
    async save(state, set, clear = []) {
      check();
      if (writing || !session || state.status !== 'ready' || !state.revision || !state.operationId)
        throw new Error('CLOUD_SETTINGS_NOT_READY');
      const handle = session.handle;
      const change = settingsWebUpdateSchema.parse({
        domain: state.domain,
        operationId: state.operationId,
        expectedRevision: state.revision,
        set,
        clear,
      });
      writing = true;
      try {
        let raw: SettingsWebResult;
        let answered = true;
        try {
          raw = await call(() => bridge.save({ handle, change }));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'CLOUD_SETTINGS_SAVE_UNCONFIRMED')
            throw error;
          answered = false;
          try {
            raw = await call(() => bridge.receipt({ handle, operationId: state.operationId! }));
          } catch (receiptError) {
            // The write may have landed; only the receipt lookup failed.
            if (receiptError instanceof Error && receiptError.message.includes('SCOPE_CHANGED'))
              throw receiptError;
            throw new Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
          }
        }
        // The instance answered the update itself with a refusal (for example a validation error).
        const refused = answered && settingsWebResultSchema.safeParse(raw);
        if (refused && refused.success && !refused.data.ok && refused.data.code !== 'CONFLICT')
          throw new Error('CLOUD_SETTINGS_REJECTED');
        const r = result(raw);
        if (!r.ok || !('receipt' in r)) throw new Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
        const receipt = r.receipt;
        if (
          !('operationId' in receipt) ||
          receipt.operationId !== state.operationId ||
          receipt.domain !== state.domain ||
          !receipt.saved ||
          receipt.status !== 'saved'
        )
          throw new Error(
            receipt.status !== 'rejected'
              ? 'CLOUD_SETTINGS_SAVE_UNCONFIRMED'
              : 'code' in receipt && receipt.code === 'CONFLICT'
                ? 'CLOUD_SETTINGS_CONFLICT'
                : 'CLOUD_SETTINGS_REJECTED',
          );
        const [saved] = await read([state.domain]).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes('SCOPE_CHANGED')) throw error;
          // Saved, but the new revision could not be read back.
          throw new Error('CLOUD_SETTINGS_CHANGED');
        });
        if (!saved || saved.status !== 'ready' || saved.revision !== receipt.revision)
          throw new Error('CLOUD_SETTINGS_CHANGED');
        return { state: saved, application: receipt.application };
      } finally {
        writing = false;
      }
    },
    cancelAuthorizations() {
      if (closed || !session) return;
      try {
        check();
        void bridge.cancelAuthorizations({ handle: session.handle }).catch(() => {});
      } catch {
        /* Main owns invalidation. */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      const old = session;
      session = undefined;
      if (old) void bridge.close({ handle: old.handle }).catch(() => {});
    },
  };
}
