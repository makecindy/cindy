import { toast } from '@/lib/toast';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isSharedTaskPeer,
  isProviderSharePeer,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { GhostInstallConsentContent } from '@/cindy-brain/GhostInstallConsentHost';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { usePluginDeviceDirectory } from '@/features/plugin/PluginDevicePicker';
import { extractIpcError } from '@/utils/ipcError';
import {
  invokePluginManagement,
  parsePluginManagementReceipt,
} from '@/features/plugin/remotePluginManagementClient';
import type { PluginUiConsentSnapshot } from '../../../shared/pluginUiConsent';
import { subscribeRemotePluginUiConsent, refreshRemotePluginUiConsent, invalidateRemotePluginUiConsent } from '@/features/plugin/remotePluginUiConsent';

export function RemotePluginUiEnablePrompt({ deviceId }: { deviceId: string }) {
  if (isSharedTaskPeer(deviceId) || isProviderSharePeer(deviceId)) return null;
  return <OwnerPrompt key={deviceId} deviceId={deviceId} />;
}
function OwnerPrompt({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const directory = usePluginDeviceDirectory({ deviceId, name: deviceId });
  const [snapshot, setSnapshot] = useState<PluginUiConsentSnapshot>();
  const [operation, setOperation] = useState<string>();
  const [unknown, setUnknown] = useState(false);
  const [ready, setReady] = useState(false);
  const owner = useRef(getDataOwnerGeneration());
  const wasOnline = useRef(false);
  const live = useRef({ active: true, online: directory.online });
  live.current.online = directory.online;
  const abort = useRef<AbortController | undefined>(undefined);
  const operationKind = useRef<'approve-ui' | 'defer-ui'>('approve-ui');
  const answered = useRef(new Set<string>());
  const operationRef = useRef<string | undefined>(undefined);
  const current = () => live.current.active && isDataOwnerGenerationCurrent(owner.current);
  const invoke = (action: string, input: Record<string, unknown> = {}, instance?: string) => {
    if (!current() || !live.current.online) throw new Error('PRECONDITION_FAILED');
    return invokePluginManagement(deviceId, action, input, instance);
  };
  const refresh = () => refreshRemotePluginUiConsent(deviceId);
  useEffect(() => {
    live.current.active = true;
    return () => {
      live.current.active = false;
      abort.current?.abort();
      if (operationRef.current && isDataOwnerGenerationCurrent(owner.current))
        void invokePluginManagement(deviceId, 'cancel', {
          operationId: operationRef.current,
        }).catch(() => {});
    };
  }, [deviceId]);
  useEffect(() => {
    const disconnected = wasOnline.current && !directory.online;
    wasOnline.current = directory.online;
    if (!directory.online) {
      abort.current?.abort();
      // Each directory Hook starts offline while getState is pending. A new
      // composer must not invalidate another composer's live shared entry.
      if (disconnected) invalidateRemotePluginUiConsent(deviceId);
      return;
    }
    return subscribeRemotePluginUiConsent(deviceId, value => {
      if (current()) setSnapshot(value);
    });
  }, [deviceId, directory.online]);
  const reconcile = async (id: string) => {
    try {
      const receipt = parsePluginManagementReceipt(
        await invoke('operation', { operationId: id }),
        id,
      );
      if (!current() || operationRef.current !== id) return;
      setUnknown(false);
      if (
        receipt.phase === 'confirmation' &&
        receipt.consent &&
        !abort.current &&
        !answered.current.has(receipt.consent.requestId)
      ) {
        const consent = receipt.consent;
        const controller = new AbortController();
        abort.current = controller;
        try {
          const accepted = await confirm(
            {
              title: t('newChat.pluginUi.title', { name: consent.facts.name }),
              description: directory.target?.name ?? deviceId,
              content: (
                <>
                  <p className="text-13 text-[var(--text-secondary)]">
                    {t(`mcpApps.pluginTrust.${consent.trust ?? 'unverified'}`)}
                  </p>
                  <GhostInstallConsentContent facts={consent.facts} capabilityOnly />
                </>
              ),
              confirmText: t('newChat.pluginUi.enable'),
              cancelText: t('settings.ghosts.installConsent.cancel'),
              maxWidth: 460,
              contentSelectable: true,
            },
            controller.signal,
          );
          if (
            !current() ||
            !live.current.online ||
            controller.signal.aborted ||
            operationRef.current !== id
          )
            return;
          // Mark before send. A missing receipt is queried; an approval is never replayed.
          answered.current.add(consent.requestId);
          await invoke('answer', {
            operationId: id,
            requestId: consent.requestId,
            confirmed: accepted,
          });
        } finally {
          if (abort.current === controller) abort.current = undefined;
        }
      } else if (['succeeded', 'failed', 'cancelled'].includes(receipt.phase)) {
        if (receipt.phase === 'failed') toast.error(t(`settings.ghosts.remote.${receipt.errorCode === 'NOT_FOUND' ? 'changed' : 'actionFailed'}`));
        setReady(receipt.phase === 'succeeded' && operationKind.current !== 'defer-ui');
        operationRef.current = undefined;
        setOperation(undefined);
        await refresh();
      }
    } catch {
      if (current() && operationRef.current === id) setUnknown(true);
    }
  };
  useEffect(() => {
    if (!operation || !directory.online) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await reconcile(operation);
      if (active && operationRef.current === operation) timer = setTimeout(tick, 1_200);
    };
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [operation, directory.online]);
  const item = snapshot?.item;
  const begin = async (kind: 'approve-ui' | 'defer-ui') => {
    if (!item || operationRef.current || snapshot?.uiCapabilityApproval !== true) return;
    const id = crypto.randomUUID();
    operationKind.current = kind;
    operationRef.current = id;
    try {
      await invoke(
        'begin',
        {
          operationId: id,
          kind,
          uiConsentVersion: 1,
          expectedInstalledApproval: item.approvalToken,
        },
        item.instanceKey,
      );
    } catch (error) {
      if (!current() || operationRef.current !== id) return;
      const code = extractIpcError(error)?.code;
      if (['INVALID_PARAMS', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED'].includes(code ?? '')) {
        // The Host rejected begin before creating an operation. Only an explicit
        // user action may retry against the refreshed install/approval snapshot.
        operationRef.current = undefined;
        setOperation(undefined);
        setUnknown(false);
        toast.error(t(`settings.ghosts.remote.${code === 'NOT_FOUND' ? 'changed' : 'actionFailed'}`));
        await refresh();
        return;
      }
      setUnknown(true);
    }
    // Even uncertain begin is only reconciled, never resubmitted.
    if (current()) setOperation(id);
  };
  if (!current() || (!item && !ready && !unknown)) return null;
  return (
    <div className="w-full rounded-xl border border-border p-3 text-13 text-[var(--text-primary)]">
      <p>
        {unknown
          ? t('settings.ghosts.remote.unknown')
          : item
            ? t('newChat.pluginUi.title', { name: item.name })
            : t('newChat.pluginUi.ready')}
      </p>
      {item && snapshot?.uiCapabilityApproval !== true ? (
        <p>{t('newChat.pluginUi.updateHost')}</p>
      ) : (
        item && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!directory.online || !!operation}
              onClick={() => void begin('approve-ui')}
            >
              {t('newChat.pluginUi.enable')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!directory.online || !!operation}
              onClick={() => void begin('defer-ui')}
            >
              {t('newChat.pluginUi.later')}
            </Button>
          </div>
        )
      )}
    </div>
  );
}
