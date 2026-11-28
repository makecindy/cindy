/**
 * SshAccessSetting —— 「这台电脑」卡片里的「允许我的其他设备通过 SSH 连接这台电脑」(SSH 访问的被控端,
 * spec 决定 5,2026-11-26)。只在主开关打开时由 MyDevicesPanel 的 selfSettings 槽渲染;不支持的电脑
 * (Windows、托管云实例)读到 supported=false 时整块不显示。
 *
 *  - 开关只存用户的选择,「恢复默认」删除它(云主机默认开,其它电脑默认关);
 *  - 打开后列出可以 SSH 的设备与手动添加的公钥。设备行「移除」= 撤销那台设备的远程访问(确认框写明远程控制
 *    一起收回);手动公钥直接移除;「添加公钥」粘贴一行 ed25519 公钥;「断开全部 SSH 会话」确认后报告结果;
 *  - 对方连不上时给出指引:macOS 去「系统设置 → 通用 → 共享 → 远程登录」(从不替用户打开),Linux 给出
 *    可复制的安装命令(从不执行 sudo)。
 *
 * 多句文案由各语言的整句字符串负责句间空格和标点(中文、日文句间不加空格),这里不拼接两句译文。
 *
 * 状态由主进程持有(ssh-access/sshAccessTargetCore.ts),这里只读和发操作;变化通知合并成一次重读,
 * 在途读取期间最多记一笔待读(engineering-conventions §8.6)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, X } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import appI18n from 'i18next';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  SSH_ACCESS_MAX_MANUAL_KEYS,
  deviceAliasSlug,
  type SshAccessDeviceRow,
  type SshAccessLocalState,
  type SshAccessSessionCleanup,
} from '../../../shared/sshAccess';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { remoteControlSettings } from './RemoteControlSection.settings-search';

/** Debian / Ubuntu (Cindy's cloud images); other distributions get a sentence instead. */
export const SSHD_INSTALL_COMMAND = 'sudo apt install -y openssh-server && sudo systemctl enable --now ssh';
/** Add-key refusals with their own sentence in the dialog (and SSH_ACCESS_KEY_LIMIT, which names the limit). */
const ADD_KEY_ERRORS = new Set(['INVALID_PARAMS', 'ALREADY_EXISTS', 'PRECONDITION_FAILED']);
/** A result toast with a second sentence stays up long enough to read it. */
const LONG_RESULT_TOAST_MS = 5000;

type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * The alias this computer's other devices give it (`cindy-<slug>`, else a device id prefix): their hosts follow this
 * computer's current name (sshAccessController.ts). Only a name another of their hosts already uses gives them another.
 */
function usualAlias(name: string | undefined, deviceId: string | undefined): string | null {
  const slug = deviceAliasSlug(name ?? '');
  if (slug) return `cindy-${slug}`;
  const token = (deviceId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return token.length >= 8 ? `cindy-${token.slice(0, 8)}` : null;
}

function shortFingerprint(fingerprint: string): string {
  const body = fingerprint.replace(/^SHA256:/, '');
  return body.length > 10 ? `SHA256:${body.slice(0, 4)}…${body.slice(-4)}` : fingerprint;
}

function formatWhen(ms: number, t: Translate): string {
  if (!ms) return '';
  const date = new Date(ms);
  const time = date.toLocaleTimeString(appI18n.language, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? t('settings.remoteControl.sshAccess.todayAt', { time })
    : date.toLocaleDateString(appI18n.language, { month: 'short', day: 'numeric' });
}

/** macOS System Settings → General → Sharing, scrolled to Remote Login (allowlisted by `shell:open-external`). */
export const MAC_REMOTE_LOGIN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin';

async function copyText(text: string, t: (key: string) => string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t('settings.remoteControl.sshAccess.copied'));
  } catch {
    toast.error(t('settings.remoteControl.sshAccess.copyFailed'));
  }
}

/** After 「断开全部 SSH 会话」: how many ended, or a warning where this computer cannot end them (running as root). */
function showAllSessionsEnded(cleanup: SshAccessSessionCleanup, t: Translate): void {
  if (!cleanup.supported) toast.warning(t('settings.remoteControl.sshAccess.sessionsUnsupported'));
  else toast.success(t('settings.remoteControl.sshAccess.sessionsEnded', { count: cleanup.terminated }));
}

/**
 * After a device's access was revoked: what became of its SSH sessions. Ending one device's sessions needs each
 * session's key, which only Linux gives, and never as root (sessionTerminator.ts); where that is not possible
 * (`supported: false`, the same capability as `endsDeviceSessions`) they stay open, as the confirmation said.
 * Sessions whose key could not be identified are left running: a warning that names the way to end them.
 * Nothing ended and nothing left running is the plain result, without a count of zero.
 */
function showDeviceRemoved(name: string, sessions: SshAccessSessionCleanup | null, t: Translate): void {
  if (sessions && !sessions.supported) {
    toast.success(t('settings.remoteControl.sshAccess.deviceRemovedSessionsKept', { name }), { duration: LONG_RESULT_TOAST_MS });
  } else if (sessions && sessions.unmapped > 0) {
    toast.warning(t('settings.remoteControl.sshAccess.deviceRemovedSessionsLeft', {
      name,
      count: sessions.terminated,
      unmapped: sessions.unmapped,
    }));
  } else if (sessions && sessions.terminated > 0) {
    toast.success(
      t('settings.remoteControl.sshAccess.deviceRemovedSessionsEnded', { name, count: sessions.terminated }),
      { duration: LONG_RESULT_TOAST_MS },
    );
  } else {
    toast.success(t('settings.remoteControl.sshAccess.deviceRemoved', { name }));
  }
}

function KeyRow({ name, meta, inactive, onRemove, busy }: {
  name: string;
  meta: string;
  inactive: boolean;
  onRemove: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-12 text-[var(--text-primary)]" title={name}>{name}</span>
        <span className="break-words text-11 text-[var(--text-tertiary)]">
          {meta}
          {inactive ? ` · ${t('settings.remoteControl.sshAccess.inactive')}` : ''}
        </span>
      </div>
      <Button
        data-settings-search-action="Remove this device or public key from SSH access to this computer"
        variant="secondary"
        size="sm"
        compact
        type="button"
        disabled={busy}
        onClick={onRemove}
      >
        {t('settings.remoteControl.sshAccess.remove')}
      </Button>
    </li>
  );
}

function AddKeyDialog({ open, onOpenChange, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (publicKey: string, note: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setKey('');
    setNote('');
    setError(null);
  }, [open]);
  const submit = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const failure = await onAdd(key, note);
      if (failure) setError(failure);
      else onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keyRef.current?.focus();
          }}
          className="modal-panel fixed left-1/2 top-1/2 z-modal flex w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
                {t('settings.remoteControl.sshAccess.addKeyDialog.heading')}
              </Dialog.Title>
              <Dialog.Description className="text-13 leading-[1.5] text-[var(--confirm-desc)]">
                {t('settings.remoteControl.sshAccess.addKeyDialog.body')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                data-settings-search-action="Close the add public key dialog"
                variant="secondary"
                tone="quiet"
                size="md"
                type="button"
                disabled={saving}
                aria-label={t('common.dismiss')}
                className="w-8 shrink-0 px-0"
              >
                <X size={16} aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <FormField label={t('settings.remoteControl.sshAccess.addKeyDialog.keyField')} error={error}>
            {(control) => (
              <Textarea
                {...control}
                data-settings-search-action="Paste the ssh-ed25519 public key to allow"
                textareaRef={keyRef}
                value={key}
                onChange={(value) => { setKey(value); setError(null); }}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…"
                className="resize-none break-all font-mono text-12"
              />
            )}
          </FormField>
          <FormField label={t('settings.remoteControl.sshAccess.addKeyDialog.noteField')}>
            {(control) => (
              <Input
                {...control}
                data-settings-search-action="Name the public key being added"
                value={note}
                onChange={setNote}
                maxLength={64}
                placeholder={t('settings.remoteControl.sshAccess.addKeyDialog.notePlaceholder')}
              />
            )}
          </FormField>
          <div className="flex flex-wrap justify-end gap-2.5">
            <Button
              data-settings-search-action="Cancel adding a public key"
              variant="secondary"
              size="lg"
              type="button"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t('commonUi.confirmDialog.cancel')}
            </Button>
            <Button
              data-settings-search-action="Add the pasted public key to SSH access"
              variant="primary"
              size="lg"
              type="button"
              loading={saving}
              disabled={!key.trim() || saving}
              onClick={() => void submit()}
            >
              {t('settings.remoteControl.sshAccess.addKeyDialog.submit')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SshAccessSetting({ selfName, selfDeviceId, deviceNames }: {
  /** This computer's name in the device list, for the alias its other devices usually use. */
  selfName?: string;
  selfDeviceId?: string;
  /** Names from the device list, for device rows this computer never saw a name for. */
  deviceNames?: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const api = window.electronAPI?.sshAccess;
  const [state, setState] = useState<SshAccessLocalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SshAccessDeviceRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  // The bridge is looked up here rather than used as a dependency, so a bridge whose identity changes per access
  // cannot turn every render into another read.
  useEffect(() => {
    mounted.current = true;
    const api = window.electronAPI?.sshAccess;
    if (!api) return;
    let reading = false;
    let again = false;
    const read = () => {
      if (reading) { again = true; return; }
      reading = true;
      void api.read()
        .then((next) => { if (mounted.current) setState(next); })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
          if (again && mounted.current) { again = false; read(); }
        });
    };
    read();
    const off = api.onChanged(read);
    return () => { mounted.current = false; off(); };
  }, []);

  /** One operation at a time; the returned state replaces the shown one. `failure` names what did not happen. */
  const run = useCallback(async <T,>(
    operation: () => Promise<T>,
    apply: (result: T) => SshAccessLocalState,
    failure: string,
  ): Promise<T | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (mounted.current) setState(apply(result));
      return result;
    } catch {
      toast.error(failure);
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  if (!api || !state?.supported) return null;
  const title = t('settings.remoteControl.sshAccess.title');
  const alias = usualAlias(selfName, selfDeviceId);
  const rows = state.devices.length + state.manualKeys.length;
  const deviceName = (row: SshAccessDeviceRow) => row.deviceName ?? deviceNames?.get(row.deviceId)
    ?? t('settings.remoteControl.sshAccess.unknownDevice');
  // Whether revoking a device also ends its sessions here (Linux, Cindy not running as root), from the same capability
  // that decides the result toast (sessionTerminator.ts); the confirmation never promises more than that.
  const endsDeviceSessions = state.endsDeviceSessions;
  const toggleFailed = t('settings.remoteControl.sshAccess.toggleFailed');

  const addKey = async (publicKey: string, note: string): Promise<string | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.addKey(publicKey, note.trim() || undefined);
      if (mounted.current) setState(result.state);
      toast.success(t('settings.remoteControl.sshAccess.addedKey'));
      return null;
    } catch (error) {
      const code = extractIpcError(error)?.code;
      if (code === 'SSH_ACCESS_KEY_LIMIT') {
        return t('settings.remoteControl.sshAccess.addKeyErrors.SSH_ACCESS_KEY_LIMIT', { max: SSH_ACCESS_MAX_MANUAL_KEYS });
      }
      return t(`settings.remoteControl.sshAccess.addKeyErrors.${code && ADD_KEY_ERRORS.has(code) ? code : 'INTERNAL'}`);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section
      id={remoteControlSettings.sshAccess.targetId}
      aria-label={title}
      className="flex flex-col gap-3 rounded-lg bg-[var(--settings-input-bg)] p-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--text-primary)]">{title}</p>
          <p className="text-12 text-[var(--text-tertiary)]">
            {t('settings.remoteControl.sshAccess.descriptionWithDefault', {
              description: t('settings.remoteControl.sshAccess.description'),
              defaultNote: t(state.defaultSetting ? 'settings.remoteControl.sshAccess.defaultOn' : 'settings.remoteControl.sshAccess.defaultOff'),
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DefaultOverrideControls
            isCustomized={state.customized}
            disabled={busy}
            onReset={() => void run(() => api.restoreDefault(), (next) => next, toggleFailed)}
          />
          <Switch
            data-setting-id={remoteControlSettings.sshAccess.id}
            aria-label={title}
            checked={state.setting}
            disabled={busy || state.recordUnreadable}
            onCheckedChange={(next) => void run(() => api.setEnabled(next), (result) => result, toggleFailed)}
          />
        </div>
      </div>

      {state.recordUnreadable && (
        <p role="alert" className="text-12 text-[var(--text-primary)]">
          {t('settings.remoteControl.sshAccess.recordUnreadable')}
        </p>
      )}

      {state.setting && state.blocked && state.blocked !== 'PLATFORM_UNSUPPORTED' && (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2.5">
          <p className="text-12 leading-[1.5] text-[var(--text-primary)]">
            {t(`settings.remoteControl.sshAccess.blocked.${state.blocked}`)}
          </p>
          {state.blocked === 'REMOTE_LOGIN_OFF' && (
            <div>
              <Button
                data-settings-search-action="Open the macOS Sharing settings to turn on Remote Login"
                variant="secondary"
                size="sm"
                compact
                type="button"
                onClick={() => void window.electronAPI.openExternal(MAC_REMOTE_LOGIN_SETTINGS_URL)}
              >
                {t('settings.remoteControl.sshAccess.openSharingSettings')}
              </Button>
            </div>
          )}
          {state.blocked === 'SSHD_UNREACHABLE' && (
            <>
              <div className="flex items-start gap-2">
                <code
                  // design: intrinsic-geometry — 行内代码，与 Markdown 行内代码同为 6px（DESIGN.md §5 内容排版）
                  className="min-w-0 flex-1 select-text break-all rounded-[6px] bg-[var(--surface-elevated)] px-2 py-1 font-mono text-11 text-[var(--text-primary)]"
                >
                  {SSHD_INSTALL_COMMAND}
                </code>
                <Button
                  data-settings-search-action="Copy the command that installs and starts the SSH server"
                  variant="secondary"
                  size="sm"
                  compact
                  type="button"
                  onClick={() => void copyText(SSHD_INSTALL_COMMAND, t)}
                >
                  <Copy size={12} aria-hidden />
                  {t('settings.remoteControl.sshAccess.copyCommand')}
                </Button>
              </div>
              <p className="text-11 text-[var(--text-secondary)]">{t('settings.remoteControl.sshAccess.otherDistributions')}</p>
            </>
          )}
        </div>
      )}

      {state.setting && (
        <>
          {alias && state.enabled && !state.blocked && (
            <div className="flex items-center gap-1.5">
              <p className="min-w-0 text-12 text-[var(--text-secondary)]">
                {/* The string places the command, with or without a space after its colon. */}
                <Trans
                  i18nKey="settings.remoteControl.sshAccess.aliasIntro"
                  values={{ command: `ssh ${alias}` }}
                  components={{ command: <code className="select-text font-mono text-[var(--text-primary)]" /> }}
                />
              </p>
              <Tip text={t('settings.remoteControl.sshAccess.device.copy')}>
                <Button
                  data-settings-search-action="Copy the terminal command that opens SSH to this computer"
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  type="button"
                  aria-label={t('settings.remoteControl.sshAccess.device.copy')}
                  className="w-7 shrink-0 px-0"
                  onClick={() => void copyText(`ssh ${alias}`, t)}
                >
                  <Copy size={13} aria-hidden />
                </Button>
              </Tip>
            </div>
          )}
          <div className="flex flex-col border-t border-[var(--border-default)] pt-2">
            <span className="text-11 text-[var(--text-tertiary)]">
              {t('settings.remoteControl.sshAccess.listHeading', { count: rows })}
            </span>
            {rows === 0 ? (
              <p className="py-1.5 text-12 text-[var(--text-tertiary)]">{t('settings.remoteControl.sshAccess.listEmpty')}</p>
            ) : (
              <ul className="flex flex-col">
                {state.devices.map((row) => (
                  <KeyRow
                    key={`device:${row.deviceId}`}
                    name={deviceName(row)}
                    meta={t('settings.remoteControl.sshAccess.deviceMeta', { time: formatWhen(row.enrolledAt, t) })}
                    inactive={!row.active}
                    busy={busy}
                    onRemove={() => setRemoveTarget(row)}
                  />
                ))}
                {state.manualKeys.map((row) => (
                  <KeyRow
                    key={`key:${row.fingerprint}`}
                    name={row.label || t('settings.remoteControl.sshAccess.unnamedKey')}
                    meta={t('settings.remoteControl.sshAccess.manualMeta', { fingerprint: shortFingerprint(row.fingerprint) })}
                    inactive={!row.active}
                    busy={busy}
                    onRemove={() => void run(() => api.removeKey(row.fingerprint), (next) => {
                      toast.success(t('settings.remoteControl.sshAccess.removedKey'));
                      return next;
                    }, t('settings.remoteControl.sshAccess.removeKeyFailed'))}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              data-settings-search-action="Open the dialog to paste a public key allowed to SSH into this computer"
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy || state.recordUnreadable}
              onClick={() => setAddOpen(true)}
            >
              {t('settings.remoteControl.sshAccess.addKey')}
            </Button>
            <Button
              data-settings-search-action="Confirm ending every SSH session of this computer's user"
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setEndOpen(true)}
            >
              {t('settings.remoteControl.sshAccess.endSessions')}
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open && !busyRef.current) setRemoveTarget(null); }}
        title={t('settings.remoteControl.sshAccess.removeDeviceConfirm.heading', { name: removeTarget ? deviceName(removeTarget) : '' })}
        description={t(
          endsDeviceSessions
            ? 'settings.remoteControl.sshAccess.removeDeviceConfirm.body'
            : 'settings.remoteControl.sshAccess.removeDeviceConfirm.bodyKeepsSessions',
          { name: removeTarget ? deviceName(removeTarget) : '' },
        )}
        // The same revocation as 「撤销访问权限」 on the device card, so the same button.
        confirmText={t('settings.remoteControl.revokeConfirm.confirm')}
        confirmVariant="destructive"
        loading={busy && removeTarget !== null}
        onConfirm={() => {
          const target = removeTarget;
          if (!target) return;
          const name = deviceName(target);
          void run(() => api.removeDevice(target.deviceId), (result) => {
            showDeviceRemoved(name, result.sessions, t);
            return result.state;
          }, t('settings.remoteControl.sshAccess.removeDeviceFailed', { name }))
            .finally(() => { if (mounted.current) setRemoveTarget(null); });
        }}
      />
      <ConfirmDialog
        open={endOpen}
        onOpenChange={(open) => { if (!open && !busyRef.current) setEndOpen(false); }}
        title={t('settings.remoteControl.sshAccess.endSessionsConfirm.heading')}
        description={t('settings.remoteControl.sshAccess.endSessionsConfirm.body')}
        confirmText={t('settings.remoteControl.sshAccess.endSessionsConfirm.action')}
        confirmVariant="destructive"
        loading={busy && endOpen}
        onConfirm={() => {
          void run(() => api.endAllSessions(), (result) => {
            showAllSessionsEnded(result.sessions, t);
            return result.state;
          }, t('settings.remoteControl.sshAccess.endSessionsFailed'))
            .finally(() => { if (mounted.current) setEndOpen(false); });
        }}
      />
      <AddKeyDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addKey} />
    </section>
  );
}
