import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import { useResendCountdown } from '@/components/login/useResendCountdown';
import type { DesktopContactChangeType } from '../../../shared/authIpc';
import { generalSettings } from './GeneralSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

type Step = 'intro' | 'current-code' | 'new-value' | 'new-code';

/** 这些错误说明换绑票据已失效,只能从验证当前联系方式重新开始。 */
const RESTART_CODES = new Set(['CONTACT_CHANGE_TICKET_INVALID', 'AUTH_FLOW_SUPERSEDED']);

/**
 * 确认更换时这些错误指向新联系方式本身(已被占用、与当前相同、邮箱不可用)。服务端此时
 * 不消费票据,退回「输入新联系方式」并保留输入,改完可直接重新发码,不必再验证当前联系方式。
 */
const NEW_VALUE_CODES = new Set([
  'CONTACT_TAKEN',
  'CONTACT_UNCHANGED',
  'EMAIL_DOMAIN_BLOCKED',
  'EMAIL_PATTERN_BLOCKED',
]);

/**
 * 「换绑登录手机号 / 邮箱」入口与分步弹窗:先验证当前联系方式,再验证新联系方式。
 * 入口是用户卡片 ID 行后的小号文字按钮(不单独占设置分组);不可换绑时不渲染。
 * 入口只读 main 的本地可用性(不发网络请求);打开弹窗并点击发送后才访问服务端。
 * 票据、凭据与网络都在 Electron main,本组件只持有展示状态与用户输入。
 */
export function ContactChangeAction() {
  const { t } = useTranslation();
  const setting = useSettingDefinition(generalSettings.contactChange);
  const { user, mode } = useAuth();
  const currentUserId = user?.id ?? null;
  const [type, setType] = useState<DesktopContactChangeType | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [maskedTarget, setMaskedTarget] = useState('');
  const [newValue, setNewValue] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const busyRef = useRef(false);
  const countdown = useResendCountdown(open && (step === 'current-code' || step === 'new-code'));

  useEffect(() => {
    if (mode !== 'cloud' || !currentUserId) {
      setType(null);
      return;
    }
    let stale = false;
    void window.electronAPI
      .authGetContactChangeAvailability()
      .then((availability) => {
        if (!stale) setType(availability.available ? availability.type : null);
      })
      .catch(() => {
        if (!stale) setType(null);
      });
    return () => {
      stale = true;
    };
  }, [currentUserId, mode]);

  if (!type) return null;

  const resetDraft = () => {
    setStep('intro');
    setMaskedTarget('');
    setNewValue('');
    setCode('');
    setErrorCode(null);
  };

  const close = () => {
    setOpen(false);
    resetDraft();
    void window.electronAPI.authCancelContactChange().catch(() => undefined);
  };

  /** 串行执行一步;失败时展示错误码,票据失效则回到第一步,其余失败交给 onFailure。 */
  const run = async <T,>(
    operation: () => Promise<{ success: true; value: T } | { success: false; code: string }>,
    onSuccess: (value: T) => void,
    onFailure?: (code: string) => void,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await operation();
      if (result.success) {
        onSuccess(result.value);
        return;
      }
      setErrorCode(result.code);
      if (RESTART_CODES.has(result.code)) {
        setStep('intro');
        setCode('');
      } else {
        onFailure?.(result.code);
      }
    } catch {
      setErrorCode('AUTH_REQUEST_FAILED');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendCurrentCode = () =>
    run(
      () => window.electronAPI.authRequestContactChangeCurrentCode(),
      (sent) => {
        setMaskedTarget(sent.maskedTarget);
        setCode('');
        setStep('current-code');
        countdown.arm();
      },
    );

  const verifyCurrentCode = () =>
    run(
      () => window.electronAPI.authVerifyContactChangeCurrentCode(code),
      () => {
        setCode('');
        setStep('new-value');
      },
    );

  const sendNewCode = () =>
    run(
      () => window.electronAPI.authRequestContactChangeNewCode(newValue),
      () => {
        setCode('');
        setStep('new-code');
        countdown.arm();
      },
    );

  const confirmChange = () =>
    run(
      () => window.electronAPI.authConfirmContactChange({ value: newValue, code }),
      (completed) => {
        toast.success(t(`settings.contactChange.${type}.success`, { target: completed.maskedValue }));
        close();
      },
      (failedCode) => {
        if (!NEW_VALUE_CODES.has(failedCode)) return;
        setCode('');
        setStep('new-value');
      },
    );

  const onConfirm = () => {
    if (step === 'intro') void sendCurrentCode();
    else if (step === 'current-code') void verifyCurrentCode();
    else if (step === 'new-value') void sendNewCode();
    else void confirmChange();
  };

  const confirmDisabled =
    step === 'current-code' || step === 'new-code'
      ? code.length !== 6
      : step === 'new-value'
        ? newValue.trim().length === 0
        : false;

  const title =
    step === 'new-value' || step === 'new-code'
      ? t(`settings.contactChange.${type}.newTitle`)
      : t(`settings.contactChange.${type}.verifyTitle`);

  const description =
    step === 'intro'
      ? t(`settings.contactChange.${type}.introDescription`)
      : step === 'current-code'
        ? t('settings.contactChange.codeSent', { target: maskedTarget })
        : step === 'new-value'
          ? t(`settings.contactChange.${type}.newDescription`)
          : t('settings.contactChange.codeSent', { target: newValue.trim() });

  const confirmText =
    step === 'intro' || step === 'new-value'
      ? t('settings.contactChange.sendCode')
      : step === 'current-code'
        ? t('settings.contactChange.next')
        : t('settings.contactChange.confirm');

  const errorMessage = errorCode
    ? t(`settings.contactChange.errors.${errorCode}`, {
        defaultValue: t('settings.contactChange.errors.fallback'),
      })
    : null;

  const resend = step === 'current-code' ? sendCurrentCode : sendNewCode;

  return (
    <>
      <Button
        {...setting.anchorProps}
        {...setting.controlProps}
        variant="secondary"
        tone="quiet"
        size="xxs"
        compact
        type="button"
        className="shrink-0"
        onClick={() => {
          resetDraft();
          setOpen(true);
        }}
      >
        {t(`settings.contactChange.${type}.change`)}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (busyRef.current && !next) return;
          if (next) setOpen(true);
          else close();
        }}
        title={title}
        description={description}
        confirmText={confirmText}
        cancelText={t('settings.contactChange.cancel')}
        confirmDisabled={confirmDisabled}
        autoFocusConfirm={step === 'intro'}
        loading={busy}
        onConfirm={onConfirm}
        content={
          <div className="flex flex-col gap-3">
            {step === 'new-value' && (
              <Input
                data-settings-search-action="Enter the new sign-in phone number or email inside the contact change dialog"
                autoFocus
                type={type === 'phone' ? 'tel' : 'email'}
                inputMode={type === 'phone' ? 'tel' : 'email'}
                autoComplete={type === 'phone' ? 'tel' : 'email'}
                maxLength={254}
                disabled={busy}
                value={newValue}
                onChange={setNewValue}
                ariaLabel={t(`settings.contactChange.${type}.inputLabel`)}
                placeholder={t(`settings.contactChange.${type}.placeholder`)}
              />
            )}
            {(step === 'current-code' || step === 'new-code') && (
              <>
                <Input
                  data-settings-search-action="Enter the verification code inside the contact change dialog"
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  disabled={busy}
                  value={code}
                  onChange={(next) => setCode(next.replace(/\D/g, ''))}
                  ariaLabel={t('settings.contactChange.codeLabel')}
                  placeholder={t('settings.contactChange.codePlaceholder')}
                />
                <Button
                  data-settings-search-action="Resend the verification code inside the contact change dialog"
                  variant="secondary"
                  size="md"
                  compact
                  type="button"
                  tone="quiet"
                  className="self-start"
                  disabled={busy || countdown.remaining > 0}
                  onClick={() => void resend()}
                >
                  {countdown.remaining > 0
                    ? t('settings.contactChange.resendIn', { seconds: countdown.remaining })
                    : t('settings.contactChange.resend')}
                </Button>
              </>
            )}
            {errorMessage && (
              <p role="alert" className="text-12 leading-[1.667] text-[var(--error-fg)]">
                {errorMessage}
              </p>
            )}
          </div>
        }
      />
    </>
  );
}
