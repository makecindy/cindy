/**
 * 设置 → 模型供应商底部的「分享给我的供应商」(受邀者)。常驻显示：
 *  - 列出别人分享给我的供应商(分享者头像与昵称、供应商 · 电脑、正常 / 已暂停、对方电脑不在线)，
 *    可以退出某个分享；
 *  - 「粘贴分享链接」：网页唤起 Cindy 失败时，加入页会让用户把链接粘贴到这里，交给同一个申请弹窗。
 */
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderShareReceived } from '@cindy/device-link';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

import { requestProviderShareJoin } from './joinIntent';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from './ProviderShareDialog';
import { useProviderShareReceived } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';

export function ProviderShareReceivedSection({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { received } = useProviderShareReceived();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);

  const leave = async (share: ProviderShareReceived) => {
    const ok = await confirm({
      presentation: 'standard',
      title: t('providerShare.received.leaveConfirm.title', {
        name: share.owner.displayName,
        provider: share.providerLabel,
      }),
      description: t('providerShare.received.leaveConfirm.description'),
      confirmText: t('providerShare.received.leaveConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setLeaving(share.memberId);
    try {
      await window.electronAPI.providerShare.command({ action: 'leave', memberId: share.memberId });
      toast.success(
        t('providerShare.received.left', { name: share.owner.displayName, provider: share.providerLabel }),
      );
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error)));
    } finally {
      setLeaving(null);
    }
  };

  return (
    <section
      className={cn('flex shrink-0 flex-col gap-2', className)}
      aria-labelledby="provider-share-received-title"
      data-testid="provider-share-received"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <h3
            id="provider-share-received-title"
            className="text-13 font-medium leading-[1.3] text-[var(--settings-section-title)]"
          >
            {t('providerShare.received.title')}
          </h3>
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {received.length > 0 ? t('providerShare.received.description') : t('providerShare.received.empty')}
          </p>
        </div>
        <Button
          ref={pasteButtonRef}
          variant="secondary"
          size="sm"
          compact
          onClick={() => setPasteOpen(true)}
        >
          {t('providerShare.received.paste')}
        </Button>
      </div>

      {received.length > 0 && (
        <ul className="max-h-[176px] overflow-y-auto rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
          {received.map((share, index) => {
            const paused = share.status !== 'active';
            const offline = !paused && (!share.hostOnline || !share.hostCapable);
            return (
              <li
                key={share.shareId}
                data-testid="provider-share-received-row"
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5',
                  index > 0 && 'border-t border-[var(--settings-theme-card-border)]',
                )}
              >
                <ShareAvatar displayName={share.owner.displayName} avatarUrl={share.owner.avatarUrl} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-13">
                    <span className="truncate font-medium text-[var(--text-primary)]">
                      {t('providerShare.received.fromOwner', { name: share.owner.displayName })}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          paused || offline
                            ? 'bg-[var(--remote-status-disconnected)]'
                            : 'bg-[var(--remote-status-ready)]',
                        )}
                      />
                      {paused
                        ? t('providerShare.received.statusPaused')
                        : offline
                          ? t(share.hostOnline ? 'providerShare.received.hostUnavailable' : 'providerShare.received.hostOffline')
                          : t('providerShare.received.statusActive')}
                    </span>
                  </div>
                  <span className="truncate text-12 text-[var(--text-secondary)]">
                    {t('providerShare.received.providerOnDevice', {
                      provider: share.providerLabel,
                      device: share.deviceName,
                    })}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  compact
                  loading={leaving === share.memberId}
                  disabled={leaving !== null}
                  aria-label={t('providerShare.received.leaveAria', {
                    name: share.owner.displayName,
                    provider: share.providerLabel,
                  })}
                  onClick={() => void leave(share)}
                >
                  {t('providerShare.received.leave')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {pasteOpen && (
        <ProviderSharePasteDialog
          onClose={() => {
            setPasteOpen(false);
            pasteButtonRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

/** 粘贴分享链接：交给全局申请弹窗读取(链接带前后文字也可以，main 会从中找出链接)。 */
export function ProviderSharePasteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (!text) {
      setError(t('providerShare.received.pasteDialog.empty'));
      inputRef.current?.focus();
      return;
    }
    onClose();
    requestProviderShareJoin(text);
  };

  return (
    <ProviderShareDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      initialFocusRef={inputRef}
      testId="provider-share-paste-dialog"
    >
      <form onSubmit={submit} className="flex flex-col">
        <ProviderShareDialogTitle>{t('providerShare.received.pasteDialog.title')}</ProviderShareDialogTitle>
        <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
          {t('providerShare.received.pasteDialog.description')}
        </p>
        <FormField
          className="mt-4"
          label={t('providerShare.received.pasteDialog.label')}
          error={error}
        >
          {(control) => (
            <Input
              id={control.id}
              aria-describedby={control['aria-describedby']}
              aria-invalid={control['aria-invalid']}
              error={control.error}
              inputRef={inputRef}
              size="md"
              value={value}
              onChange={(next) => {
                setValue(next);
                if (error) setError(null);
              }}
              placeholder={t('providerShare.received.pasteDialog.placeholder')}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <ProviderShareDialogFooter>
          <Button type="submit" variant="cta" palette="confirmation" size="lg">
            {t('providerShare.received.pasteDialog.open')}
          </Button>
          <Button variant="secondary" palette="confirmation" size="lg" onClick={onClose}>
            {t('providerShare.received.pasteDialog.cancel')}
          </Button>
        </ProviderShareDialogFooter>
      </form>
    </ProviderShareDialog>
  );
}
