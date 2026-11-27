import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import {
  SettingsTargetProvider,
  type SettingsTarget,
} from '@/components/settings/settingsTarget';
import {
  TelegramBehaviorSettings,
  TelegramGroupActivationSettings,
  TelegramPersonaSettings,
} from '@/components/settings/TelegramBehaviorSettings';
import { WechatWorkingDirectory } from '@/components/settings/WechatBotSection';
import { CLOUD_WECHAT_WORKING_DIR_SET } from '../../../shared/cloudImSettings';
import type { ManagementItem } from '../../../shared/settingsManagement';
import { errorCode, useBlockRetry } from './blockRetry';
import { createCloudImTarget, type CloudImAuthorization, type CloudImTarget } from './cloudImTarget';

type Action = ManagementItem['actions'][number];
/** failed: the instance's IM channel did not answer; it is read again on its own. */
export type CloudImSupport = 'probing' | 'ready' | 'unsupported' | 'failed';

/**
 * One target per instance for the native IM cards. Binding flows reuse the cloud authorization
 * tickets of the bots list; a directory is chosen in the instance's directory browser.
 */
export function useCloudImTarget({
  deviceId,
  deviceName,
  enabled,
  items,
  run,
  cancelOperation,
  operationItem,
  operationActive,
}: {
  deviceId: string;
  deviceName: string;
  /** Online and the IM page is shown. */
  enabled: boolean;
  items: ManagementItem[];
  run(item: ManagementItem, action: Action): Promise<void>;
  cancelOperation(): Promise<void>;
  operationItem?: string;
  operationActive: boolean;
}) {
  const { t } = useTranslation();
  const latest = useRef({ items, run, cancelOperation, operationItem, operationActive });
  latest.current = { items, run, cancelOperation, operationItem, operationActive };
  const [picker, setPicker] = useState<((path: string | null) => void) | null>(null);
  const target = useMemo<CloudImTarget>(() => {
    const authorization: CloudImAuthorization = {
      canAuthorizeProvider(provider) {
        return latest.current.items.some(
          (item) => item.id === `bot:official:${provider}` &&
            item.actions.some((action) => action.intent === 'authorize'),
        );
      },
      canAuthorizeSlackCommunications(teamId) {
        return latest.current.items.some((item) => item.id === `bot:official:slack:${teamId}` &&
          item.actions.some((action) => action.intent === 'connect'));
      },
      async start(request) {
        const id =
          request.kind === 'provider'
            ? `bot:official:${request.provider}`
            : request.kind === 'slack-rebind' || request.kind === 'slack-communications'
              ? `bot:official:slack:${request.teamId}`
              : 'bot:official:slack';
        const item = latest.current.items.find((entry) => entry.id === id);
        const intent = request.kind === 'slack-communications' ? 'connect' : 'authorize';
        const action = item?.actions.find((entry) => entry.intent === intent);
        if (!item || !action) throw new Error('[UNAVAILABLE] this connection cannot start now');
        await latest.current.run(item, action);
      },
      async cancel(card) {
        const { operationItem: own, operationActive: active } = latest.current;
        const id = `bot:official:${card}`;
        if (!active || !own || (own !== id && !own.startsWith(`${id}:`))) return false;
        await latest.current.cancelOperation();
        return true;
      },
    };
    return createCloudImTarget(deviceId, {
      authorization,
      pickDirectory: () => new Promise((resolve) => setPicker(() => resolve)),
    });
  }, [deviceId]);
  useEffect(() => target.setActive(enabled), [target, enabled]);
  const [support, setSupport] = useState<CloudImSupport>('probing');
  const [failures, setFailures] = useState(0);
  const [failureCode, setFailureCode] = useState<string>();
  useEffect(() => {
    setSupport('probing');
  }, [target]);
  // The target a read belongs to; a read for an earlier target is ignored.
  const probedFor = useRef(target);
  probedFor.current = target;
  const probe = useCallback(() => {
    const asked = target;
    void asked.api.hookControl
      .get()
      .then(() => probedFor.current === asked && setSupport('ready'))
      .catch((error: unknown) => {
        if (probedFor.current !== asked) return;
        const code = extractIpcError(error)?.code;
        // An older runtime keeps the ticket cards; any other failure is read again on its own,
        // then reported where the cards would be, never by falling back to them silently.
        if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'PERMISSION_DENIED')
          setSupport('unsupported');
        else {
          setSupport('failed');
          setFailureCode(code ?? errorCode(error));
          setFailures((count) => count + 1);
        }
      });
  }, [target]);
  useEffect(() => {
    if (enabled && support === 'probing') probe();
  }, [enabled, support, probe]);
  const close = (path: string | null) => {
    picker?.(path);
    setPicker(null);
  };
  const directoryPicker = picker ? (
    <AddRemoteProjectDialog
      open
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
      initialDeviceId={deviceId}
      fixedDeviceId={deviceId}
      title={t('settings.ghosts.scopePicker.projectsForComputer', { device: deviceName })}
      confirmText={t('newChat.folderPicker.selectFolder')}
      onProjectAdded={(added) => {
        close(added.kind === 'device-link' && added.deviceId === deviceId ? added.path : null);
      }}
    />
  ) : null;
  const readRetry = useBlockRetry({
    failed: enabled && support === 'failed',
    failures,
    // Read again while still failed, so the tries are counted.
    retry: probe,
  });
  return {
    target,
    support,
    directoryPicker,
    readFailure: readRetry.exhausted ? { code: failureCode, reload: readRetry.reload } : undefined,
  };
}

/** The local Telegram persona, behaviour and group sections against the instance. */
export function CloudTelegramSettings({ target }: { target: SettingsTarget }) {
  return (
    <SettingsTargetProvider target={target}>
      <TelegramPersonaSettings />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <TelegramBehaviorSettings />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <TelegramGroupActivationSettings />
    </SettingsTargetProvider>
  );
}

type WechatSettings = {
  version: 1;
  workingDir: string | null;
  workingDirAvailable: boolean;
  companionBotId?: string;
};

/** The local WeChat working directory row; the directory comes from the instance browser. */
export function CloudWechatWorkingDirectory({
  target,
  disabled,
}: {
  target: CloudImTarget;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { call } = target;
  const [settings, setSettings] = useState<WechatSettings | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true;
    void call<WechatSettings>('wechatBot:get-channel-settings')
      .then((next) => current && setSettings(next))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [call]);
  const update = useCallback(
    async (write: () => Promise<WechatSettings | null>, success: string) => {
      if (pending || disabled) return;
      setPending(true);
      try {
        const next = await write();
        if (!next) return;
        setSettings(next);
        toast.success(t(success));
      } catch {
        toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
      } finally {
        setPending(false);
      }
    },
    [disabled, pending, t],
  );
  return (
    <WechatWorkingDirectory
      settings={settings}
      pending={pending || disabled}
      onChoose={() =>
        void update(async () => {
          const chosen = await target.api.showOpenDirectoryDialog();
          return chosen.canceled || !chosen.path
            ? null
            : call<WechatSettings>(CLOUD_WECHAT_WORKING_DIR_SET, chosen.path);
        }, 'settings.wechatBot.toasts.workingDirSaved')
      }
      onReset={() =>
        void update(
          () => call<WechatSettings>('wechatBot:reset-working-directory'),
          'settings.wechatBot.toasts.workingDirReset',
        )
      }
    />
  );
}
