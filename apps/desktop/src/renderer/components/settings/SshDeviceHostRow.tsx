/**
 * SSH on another device's card in 「我的设备」(SSH 访问的控制端,spec 决定 6):
 *  - 可用:终端命令 `ssh cindy-…`(可复制)和「连接」(建立 Cindy 自己的 SSH 连接,同「SSH 远程主机」);
 *  - 用户删过主机:说明 +「添加到 SSH 远程主机」;
 *  - 对方的 Cindy 太旧:「需要更新 Cindy」;暂不可用:写明原因,主机仍留在 SSH 远程主机里。
 * 数据来自主进程的控制端记录(ssh-access/sshAccessController.ts),由 useSshDeviceHosts 在页面上读一份共用。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type { SshDeviceHostView } from '../../../shared/sshAccess';
import { SshCommandCopyButton, toastSshConnectError } from './RemoteSection';

/**
 * The hosts this computer keeps for the person's other devices, by device id. One reader for the whole page:
 * change notices (already merged in main) trigger one read at a time with at most one more queued.
 * The bridge is looked up inside the effect: every read makes a new Map, so depending on the bridge object's
 * identity would re-read on every render wherever that identity is not stable.
 */
export function useSshDeviceHosts(enabled: boolean): {
  hosts: ReadonlyMap<string, SshDeviceHostView>;
  restore: (deviceId: string) => Promise<void>;
} {
  const [hosts, setHosts] = useState<ReadonlyMap<string, SshDeviceHostView>>(() => new Map());
  useEffect(() => {
    const api = enabled ? window.electronAPI?.sshDeviceHosts : undefined;
    if (!api) return;
    let disposed = false;
    let reading = false;
    let again = false;
    const read = () => {
      if (reading) { again = true; return; }
      reading = true;
      void api.read()
        .then((rows) => { if (!disposed) setHosts(new Map(rows.map((row) => [row.deviceId, row]))); })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
          if (again && !disposed) { again = false; read(); }
        });
    };
    read();
    const off = api.onChanged(read);
    return () => { disposed = true; off(); };
  }, [enabled]);
  const restore = useCallback(async (deviceId: string) => {
    const api = enabled ? window.electronAPI?.sshDeviceHosts : undefined;
    if (!api) return;
    const rows = await api.restore(deviceId);
    setHosts(new Map(rows.map((row) => [row.deviceId, row])));
  }, [enabled]);
  return { hosts, restore };
}

/**
 * What the device said blocks SSH there, one sentence per reason. A device that gave none, or one this build does not
 * know (`UNKNOWN`, see parseSshAccessStatus), gets the neutral sentence rather than a guess.
 */
const BLOCKED_NOTES: Record<NonNullable<SshDeviceHostView['blocked']>, string> = {
  SSHD_UNREACHABLE: 'settings.remoteControl.sshAccess.device.unavailable.blocked.SSHD_UNREACHABLE',
  REMOTE_LOGIN_OFF: 'settings.remoteControl.sshAccess.device.unavailable.blocked.REMOTE_LOGIN_OFF',
  AUTHORIZED_KEYS_UNSUPPORTED: 'settings.remoteControl.sshAccess.device.unavailable.blocked.AUTHORIZED_KEYS_UNSUPPORTED',
  PLATFORM_UNSUPPORTED: 'settings.remoteControl.sshAccess.device.unavailable.blocked.PLATFORM_UNSUPPORTED',
  UNKNOWN: 'settings.remoteControl.sshAccess.device.unavailable.blocked.UNKNOWN',
};

function unavailableText(view: SshDeviceHostView, t: (key: string) => string): string {
  if (view.reason !== 'blocked') return t(`settings.remoteControl.sshAccess.device.unavailable.${view.reason ?? 'off'}`);
  const blocked = view.blocked && Object.hasOwn(BLOCKED_NOTES, view.blocked) ? view.blocked : 'UNKNOWN';
  return t(BLOCKED_NOTES[blocked]);
}

function stateText(view: SshDeviceHostView, t: (key: string) => string): string | null {
  switch (view.state) {
    case 'unavailable': return unavailableText(view, t);
    case 'user-deleted': return t('settings.remoteControl.sshAccess.device.userDeleted');
    case 'needs-update': return t('settings.remoteControl.sshAccess.device.needsUpdate');
    case 'control-off': return t('settings.remoteControl.sshAccess.device.controlOff');
    case 'error': return t('settings.remoteControl.sshAccess.device.refused');
    case 'pending': return t('settings.remoteControl.sshAccess.device.pending');
    default: return null;
  }
}

/** The row's content inside the card's access grid (label column 「SSH」 is the caller's AccessRow). */
export function SshDeviceHostRow({ view, name, onRestore }: {
  view: SshDeviceHostView;
  /** The device's name on its card, for the connected and restore-failed toasts. */
  name: string;
  onRestore: (deviceId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const command = view.alias ? `ssh ${view.alias}` : null;
  const usable = view.state === 'ready' && view.hostId !== null;
  const note = stateText(view, t);

  const connect = async () => {
    if (!view.hostId || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.remoteSsh.connect(view.hostId);
      toast.success(t('settings.remoteControl.sshAccess.device.connected', { name }));
    } catch (error) {
      toastSshConnectError(error, t);
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRestore(view.deviceId);
    } catch {
      toast.error(t('settings.remoteControl.sshAccess.device.restoreFailed', { name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {command && view.hostId !== null && (
          <code
            // design: intrinsic-geometry — 行内代码，与 Markdown 行内代码同为 6px（DESIGN.md §5 内容排版）
            className={`min-w-0 select-text break-all rounded-[6px] bg-[var(--surface-chip)] px-2 py-1 font-mono text-11 ${usable ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
          >
            {command}
          </code>
        )}
        {command && view.hostId !== null && <SshCommandCopyButton command={command} />}
        {usable && (
          <Button
            data-settings-search-action="Connect Cindy to this device's SSH host"
            variant="secondary"
            size="sm"
            compact
            type="button"
            loading={busy}
            disabled={busy}
            onClick={() => void connect()}
          >
            {t('settings.remoteControl.sshAccess.device.connect')}
          </Button>
        )}
        {view.state === 'user-deleted' && (
          <Button
            data-settings-search-action="Add this device back to the SSH host list"
            variant="secondary"
            size="sm"
            compact
            type="button"
            loading={busy}
            disabled={busy}
            onClick={() => void restore()}
          >
            {t('settings.remoteControl.sshAccess.device.restore')}
          </Button>
        )}
      </div>
      {note && <span className="text-11 text-[var(--text-tertiary)]">{note}</span>}
    </div>
  );
}
