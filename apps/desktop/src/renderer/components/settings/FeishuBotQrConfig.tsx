import { useTranslation } from 'react-i18next';
import { ExternalLink, QrCode } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import type { FeishuBotService } from '@/hooks/useFeishuBot';
import { useFeishuBotRegistration } from '@/hooks/useFeishuBotRegistration';

const SERVICES = ['feishu', 'lark'] as const;

/** 开放平台控制台入口: 扫码建出来的应用得用户自己去后台补事件订阅。 */
const OPEN_PLATFORM_URL: Record<FeishuBotService, string> = {
  feishu: 'https://open.feishu.cn/app?lang=zh-CN',
  lark: 'https://open.larksuite.com/app',
};

export function FeishuBotQrConfig({
  service,
  setService,
}: {
  service: FeishuBotService;
  setService: (service: FeishuBotService) => void;
}) {
  const { t } = useTranslation();
  const registration = useFeishuBotRegistration(service);
  const { phase, qrDataUrl, verificationUrl, userCode, secondsLeft, errorMessage } = registration;
  const isStarting = phase === 'starting';
  const isAuthorizing = phase === 'qr';
  const canRetry = phase === 'expired' || phase === 'error' || phase === 'cancelled';
  const isConnecting = phase === 'success';

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-12 font-medium text-[var(--settings-section-desc)]">
          {t('settings.feishuBot.serviceLabel')}
        </legend>
        <SegmentedControl
          aria-label={t('settings.feishuBot.serviceAria')}
          value={service}
          onValueChange={setService}
          options={SERVICES.map((value) => ({
            value,
            label: t('settings.feishuBot.services.' + value),
          }))}
          fullWidth
          height={44}
          optionHeight={34}
        />
      </fieldset>
      <p className="text-13 leading-relaxed text-[var(--settings-section-desc)]">
        {t('settings.feishuBot.qr.description')}
      </p>
      <p className="text-12 leading-relaxed text-[var(--settings-section-desc)]">
        {t('settings.feishuBot.qr.cardActionHint')}{' '}
        <button
          type="button"
          onClick={() => void window.electronAPI.openExternal(OPEN_PLATFORM_URL[service])}
          className="cursor-pointer bg-transparent p-0 font-medium text-[var(--settings-source-link)] underline underline-offset-2"
        >
          {t('settings.feishuBot.qr.cardActionHintAction')}
        </button>
      </p>
      {isAuthorizing && qrDataUrl && (
        <div className="flex flex-col items-center gap-3 py-2">
          <img
            src={qrDataUrl}
            alt={t('settings.feishuBot.qr.qrAlt')}
            width={180}
            height={180}
            className="max-w-full rounded-lg"
          />
          <span className="select-all text-13 font-medium text-[var(--settings-section-title)]">
            {userCode}
          </span>
          <span className="text-12 text-[var(--settings-section-desc)]" role="status">
            {t('settings.feishuBot.qr.expiresIn', { seconds: secondsLeft })}
          </span>
        </div>
      )}
      {isConnecting && (
        <div
          className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]"
          role="status"
        >
          <Spinner size={16} />
          {t('settings.feishuBot.qr.connecting')}
        </div>
      )}
      {phase === 'expired' && (
        <p className="text-13 text-[var(--settings-section-desc)]" role="status">
          {t('logic.errors.qrExpired')}
        </p>
      )}
      {errorMessage && phase === 'error' && (
        <p className="text-13 text-[var(--settings-error-text)]" role="alert">
          {errorMessage}
        </p>
      )}
      {isAuthorizing && verificationUrl ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="cta"
            size="lg"
            onClick={() => void window.electronAPI.openExternal(verificationUrl)}
          >
            <ExternalLink size={16} />
            {t('settings.feishuBot.qr.openLink')}
          </Button>
          <Button tone="quiet" size="lg" onClick={() => void registration.cancelRegistration()}>
            {t('settings.feishuBot.qr.cancel')}
          </Button>
        </div>
      ) : !isConnecting ? (
        <Button
          variant="cta"
          size="lg"
          loading={isStarting}
          disabled={isStarting}
          onClick={() => void registration.beginRegistration()}
          className="w-full"
        >
          <QrCode size={16} />
          {t(canRetry ? 'settings.feishuBot.qr.retry' : 'settings.feishuBot.qr.begin')}
        </Button>
      ) : null}
    </div>
  );
}
