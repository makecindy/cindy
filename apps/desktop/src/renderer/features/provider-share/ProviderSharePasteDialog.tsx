/**
 * 输入分享链接：「设置 → 模型供应商」右上角的入口。网页唤起 Cindy 失败时，加入页会让用户
 * 到这里粘贴链接，交给同一个申请弹窗。
 */
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

import { requestProviderShareJoin } from './joinIntent';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from './ProviderShareDialog';

/** 设置页右上角的「输入分享链接…」：点开输入弹窗，关闭后焦点回到按钮。 */
export function ProviderSharePasteButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={buttonRef}
        variant="secondary"
        size="md"
        className="shrink-0"
        data-testid="provider-share-paste-button"
        onClick={() => setOpen(true)}
      >
        {t('providerShare.received.enterLink')}
      </Button>
      {open && (
        <ProviderSharePasteDialog
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** 输入分享链接：交给全局申请弹窗读取(链接带前后文字也可以，main 会从中找出链接)。 */
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
