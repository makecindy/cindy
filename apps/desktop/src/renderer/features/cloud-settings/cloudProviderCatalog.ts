import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isModelVisible, type Effort, type ProviderView } from '@cindy/model-providers';

import type { ModelSettingsSource } from '@/components/settings/modelSettingsSource';
import { toast } from '@/lib/toast';
import { i18n } from '@/i18n';
import { extractIpcError } from '@/utils/ipcError';
import {
  type CloudModelCall,
  CLOUD_PROVIDER_SETTINGS_CHANNEL,
  type CloudProviderSettingsList,
  type CloudProviderSettingsRequest,
  type CloudProviderSettingsWriteReceipt,
} from '../../../shared/cloudProviderSettings';
/** Same key as the visibility preferences and the provider list's overrides. */
const visibilityPreferenceKey = (agent: string, providerId: string, modelId: string) => `${agent}:${providerId}:${modelId}`;

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Writes carry the catalog's owner generation and, for visibility, its revision. */
export type CloudProviderWrite = Without<
  Exclude<CloudProviderSettingsRequest, { op: 'list' }>,
  'ownerGeneration' | 'revision'
>;
/**
 * `unsupported`: the instance runtime predates the channel, or this account does not own the
 * instance. The page then keeps the ticket-only authorization list.
 */
export type CloudProviderCatalogStatus = 'loading' | 'ready' | 'unsupported' | 'unavailable';

function isCatalog(value: unknown): value is CloudProviderSettingsList {
  const list = value as Partial<CloudProviderSettingsList> | null;
  return (
    !!list &&
    list.version === 1 &&
    Number.isInteger(list.ownerGeneration) &&
    Array.isArray(list.providers) &&
    list.providers.every(
      (provider) =>
        !!provider &&
        typeof (provider as ProviderView).id === 'string' &&
        Array.isArray((provider as ProviderView).agents),
    ) &&
    Array.isArray(list.providerOrder) &&
    !!list.visibility &&
    typeof list.visibility.overrides === 'object' &&
    Array.isArray(list.supportedOps)
  );
}

/** The instance's provider catalog over the private DeviceLink channel. */
export function useCloudProviderCatalog({
  deviceId,
  online,
  active,
  refresh = 0,
}: {
  deviceId: string;
  online: boolean;
  active: boolean;
  refresh?: number;
}) {
  const [status, setStatus] = useState<CloudProviderCatalogStatus>('loading');
  const [list, setList] = useState<CloudProviderSettingsList | null>(null);
  const [visibilityVersion, setVisibilityVersion] = useState(0);
  const listRef = useRef(list);
  const sequence = useRef(0);
  const scope = useRef(deviceId);
  scope.current = deviceId;
  const invoke = useCallback(
    async <T>(request: CloudProviderSettingsRequest): Promise<T> =>
      (await window.electronAPI.deviceLink.invoke(deviceId, CLOUD_PROVIDER_SETTINGS_CHANNEL, [
        request,
      ])) as T,
    [deviceId],
  );
  const accept = (next: CloudProviderSettingsList | null) => {
    listRef.current = next;
    setList(next);
    setVisibilityVersion((version) => version + 1);
  };
  const load = useCallback(async () => {
    if (!deviceId || !online) return;
    const seq = ++sequence.current;
    try {
      const next = await invoke<unknown>({ op: 'list' });
      if (seq !== sequence.current || scope.current !== deviceId) return;
      if (!isCatalog(next)) throw new Error('INVALID_CATALOG');
      accept(next);
      setStatus('ready');
    } catch (error) {
      if (seq !== sequence.current || scope.current !== deviceId) return;
      const code = extractIpcError(error)?.code;
      if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'PERMISSION_DENIED')
        setStatus('unsupported');
      // A failed refresh keeps the last catalog, as the local page keeps its last snapshot.
      else setStatus(listRef.current ? 'ready' : 'unavailable');
    }
  }, [deviceId, online, invoke]);
  useEffect(() => {
    sequence.current++;
    accept(null);
    setStatus('loading');
  }, [deviceId]);
  useEffect(() => {
    if (active && online) void load();
  }, [active, online, refresh, load]);

  /** One write; resolves with the receipt and applies its visibility or effort result. */
  const send = useCallback(
    async (request: CloudProviderWrite): Promise<CloudProviderSettingsWriteReceipt> => {
      const current = listRef.current;
      if (!current || !online) throw new Error('UNAVAILABLE');
      const visibility = request.op === 'visibility-set' || request.op === 'visibility-reset';
      if (visibility && (current.visibility.status !== 'ready' || !current.visibility.revision))
        throw new Error('UNAVAILABLE');
      const receipt = await invoke<CloudProviderSettingsWriteReceipt>({
        ...request,
        ownerGeneration: current.ownerGeneration,
        ...(visibility ? { revision: current.visibility.revision } : {}),
      } as CloudProviderSettingsRequest);
      if (receipt?.ok !== true) throw new Error('INVALID_RECEIPT');
      if (receipt.visibility && listRef.current)
        accept({ ...listRef.current, visibility: receipt.visibility });
      if (request.op === 'effort' && receipt.value && listRef.current)
        accept({
          ...listRef.current,
          efforts: receipt.value as Record<string, Record<string, string>>,
        });
      if (receipt.catalogChanged) void load();
      return receipt;
    },
    [invoke, load, online],
  );

  /** Resolves false when the instance refused the write; the catalog is then reread. */
  const write = useCallback(
    async (request: CloudProviderWrite): Promise<boolean> => {
      const current = listRef.current;
      if (!current || !online) return false;
      const visibility = request.op === 'visibility-set' || request.op === 'visibility-reset';
      if (visibility && (current.visibility.status !== 'ready' || !current.visibility.revision))
        return false;
      try {
        await send(request);
        return true;
      } catch {
        // Owner, revision and catalog changes all resolve the same way: show the instance's state.
        await load();
        return false;
      }
    },
    [load, online, send],
  );

  const source = useMemo<ModelSettingsSource | null>(() => {
    if (!list) return null;
    const { visibility } = list;
    const efforts = list.efforts ?? {};
    const supported = new Set(list.supportedOps);
    const modelCall =
      (call: CloudModelCall) =>
      async (target: unknown, value?: unknown): Promise<never> => {
        // Runtimes before the model panel calls answer as unsupported; the panel shows its error.
        if (!supported.has('model-call')) throw new Error('UNSUPPORTED');
        const { providerId, agent, modelId, relatedTargets } = target as {
          providerId: string;
          agent: 'claude-code' | 'codex' | 'pi';
          modelId: string;
          relatedTargets?: Array<{ providerId: string; agent: string; modelId: string }>;
        };
        const receipt = await send({
          op: 'model-call',
          call,
          target: {
            providerId,
            agent,
            modelId,
            ...(relatedTargets?.length
              ? {
                  relatedTargets: relatedTargets.map((related) => ({
                    providerId: related.providerId,
                    agent: related.agent as 'claude-code' | 'codex' | 'pi',
                    modelId: related.modelId,
                  })),
                }
              : {}),
          },
          ...(value === undefined ? {} : { value: value as number | null }),
        });
        return receipt.value as never;
      };
    return {
      visibilityVersion,
      isModelEnabled: (agent, providerId, model) =>
        isModelVisible(
          visibility.status === 'ready'
            ? visibility.overrides[visibilityPreferenceKey(agent, providerId, model.id)]
            : undefined,
          model.defaultEnabled,
        ),
      setModelVisibilities: (providerId, targets, enabled) =>
        targets.length
          ? write({ op: 'visibility-set', providerId, targets: [...targets], enabled })
          : Promise.resolve(true),
      resetModelVisibilities: (providerId, targets) =>
        targets.length
          ? write({ op: 'visibility-reset', providerId, targets: [...targets] })
          : Promise.resolve(true),
      isModelVisibilityCustomized: (agent, providerId, modelId) =>
        visibility.status === 'ready' &&
        Object.hasOwn(visibility.overrides, visibilityPreferenceKey(agent, providerId, modelId)),
      async setModelDisable(input) {
        // Hiding a provider from the picker is a preference of the computer showing the picker.
        if (input.kind === 'provider-hidden') throw new Error('UNSUPPORTED');
        if (!(await write({ op: 'model-disable', ...input }))) throw new Error('WRITE_FAILED');
      },
      // Same lookup as this device: the global slot first, the source copy as fallback.
      getEffort: (agent, providerId, modelId) =>
        (efforts[`${agent}:*`]?.[modelId] ?? efforts[`${agent}:${providerId}`]?.[modelId]) as
          Effort | undefined,
      setEffort(agent, providerId, modelId, effort) {
        if (!supported.has('effort')) return;
        void send({ op: 'effort', agent, providerId, modelId, effort }).catch(() => {
          void load();
          toast.error(i18n.t('hostSettings.saveFailed'));
        });
      },
      editModel: (_provider, agent, modelId, edit) =>
        supported.has('model-edit')
          ? write({ op: 'model-edit', providerId: _provider.id, agent, modelId, edit })
          : Promise.resolve(false),
      maker: {
        getModelContextLimit: (target) => modelCall('context-get')(target),
        setModelContextLimit: (target, limit) => modelCall('context-set')(target, limit),
        resetModelContextLimit: (target) => modelCall('context-reset')(target),
        setModelCompaction: (target, pct) => modelCall('compaction-set')(target, pct),
        getModelPriceOverride: (target) => modelCall('price-get')(target),
        setModelPriceOverride: (target, desired) => modelCall('price-set')(target, desired),
        resetModelPriceOverride: (target) => modelCall('price-reset')(target),
        ...(supported.has('image-input')
          ? {
              getModelImageInputOverride: (target) => modelCall('image-input-get')(target),
              setModelImageInputOverride: (target, value) =>
                modelCall('image-input-set')(target, value),
            }
          : {}),
      },
    };
  }, [list, visibilityVersion, write, send, load]);

  return {
    status,
    providers: (list?.providers ?? []) as ProviderView[],
    providerOrder: list?.providerOrder ?? [],
    supportedOps: list?.supportedOps ?? [],
    shareActions: list?.shareActions ?? [],
    source,
    load,
    write,
    send,
  };
}
