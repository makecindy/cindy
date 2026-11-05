import type { ReactNode } from 'react';

import {
  LoginBackButton,
  LoginConsentDialog,
  LoginConsentRow,
  LoginErrorText,
  LoginInput,
  LoginLoadingRing,
  LoginMethodRow,
  LoginPanel,
  LoginPrimaryButton,
  LoginSkipEntry,
  LoginSocialButton,
  LoginSocialRow,
  LoginSsoOrgHistoryList,
  LoginTextLink,
  LoginTitleBlock,
} from '../../../src/renderer/components/login/LoginControls';
import { mountPage } from '../../ui-page/harness';
import i18n from '../../../src/renderer/i18n';

const noop = () => {};
const t = (key: string, options?: Record<string, string>) => i18n.t(key, options);

/** 登录组(680 设计 px)按 0.5 缩放放进画布底,与 LoginStage 的缩放方式一致。 */
function Stage({ children, height = 700 }: { children: ReactNode; height?: number }) {
  return (
    <div className="min-h-screen p-5" style={{ background: 'var(--login-bg-base)' }}>
      <div style={{ zoom: 0.5, position: 'relative', width: 680, height }}>{children}</div>
    </div>
  );
}

function SsoGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect x="13" y="8" width="22" height="32" rx="2" stroke="var(--login-primary-button-text)" strokeWidth="3" />
      <path d="M19 16h3M26 16h3M19 23h3M26 23h3M21 40v-7h6v7" stroke="var(--login-primary-button-text)" strokeWidth="3" />
    </svg>
  );
}

function Letter({ children }: { children: string }) {
  return (
    <span className="grid h-full w-full place-items-center text-[28px] font-bold" style={{ color: 'var(--login-primary-button-text)' }}>
      {children}
    </span>
  );
}

void mountPage({
  render: (ctx) => {
    if (ctx.case === 'default') {
      return (
        <Stage>
          <LoginPanel>
            <LoginTitleBlock title={t('login.title')} subtitle={t('login.personalDesc')} />
            <LoginInput value="name@example.com" onChange={noop} placeholder={t('login.emailPlaceholder')} testId="fixture-input" />
            <LoginPrimaryButton onClick={noop} testId="fixture-primary">{t('login.continue')}</LoginPrimaryButton>
            <LoginSkipEntry onClick={noop}>{t('login.localModeEntry')}</LoginSkipEntry>
          </LoginPanel>
          <LoginSocialRow count={3}>
            <LoginSocialButton label="Apple" variant="apple" onClick={noop} testId="fixture-apple">
              <Letter>A</Letter>
            </LoginSocialButton>
            <LoginSocialButton label="Google" onClick={noop} testId="fixture-google">
              <Letter>G</Letter>
            </LoginSocialButton>
            <LoginSocialButton label="SSO" onClick={noop} testId="fixture-sso">
              <SsoGlyph />
            </LoginSocialButton>
          </LoginSocialRow>
          <LoginConsentRow checked onToggle={noop} statement={t('login.consentStatement')} onOpenTerms={noop} onOpenPrivacy={noop} />
        </Stage>
      );
    }
    if (ctx.case === 'code') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginBackButton label={t('login.back')} onClick={noop} />
            <LoginTitleBlock title={t('login.enterCode')} subtitle={t('login.codeSentTo', { identifier: 'name@example.com' })} />
            <LoginInput value="" onChange={noop} placeholder={t('login.codePlaceholder')} testId="fixture-input" />
            <LoginTextLink onClick={noop} testId="fixture-link">{t('login.resendCode')}</LoginTextLink>
            <LoginPrimaryButton disabled onClick={noop}>{t('login.signIn')}</LoginPrimaryButton>
            <LoginErrorText>{t('login.errors.INVALID_CODE')}</LoginErrorText>
          </LoginPanel>
        </Stage>
      );
    }
    if (ctx.case === 'method') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginBackButton label={t('login.back')} onClick={noop} />
            <LoginTitleBlock title={t('login.chooseMethod')} subtitle={t('login.subtitle')} />
            <LoginMethodRow top={158} icon="person" title={t('login.personalLogin')} subtitle={t('login.personalDesc')} onClick={noop} testId="fixture-row" />
            <LoginMethodRow top={278} title={t('login.ssoOrgTitle')} subtitle={t('login.enterpriseLogin')} onClick={noop} />
          </LoginPanel>
        </Stage>
      );
    }
    if (ctx.case === 'sso-history') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginTitleBlock title={t('login.ssoOrgTitle')} subtitle={t('login.ssoOrgSubtitle')} />
            <LoginInput value="example" onChange={noop} placeholder={t('login.ssoOrgPlaceholder')} />
            <LoginPrimaryButton loading onClick={noop}>{t('login.continue')}</LoginPrimaryButton>
          </LoginPanel>
          <LoginSsoOrgHistoryList
            entries={['example-studio', 'example-lab']}
            value="example-studio"
            activeIndex={-1}
            onActiveIndexChange={noop}
            onSelect={noop}
            listId="fixture-sso-history"
          />
        </Stage>
      );
    }
    if (ctx.case === 'loading') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginTitleBlock title={t('login.browserWaiting')} subtitle={t('login.browserWaiting')} />
            <LoginLoadingRing y={158} label={t('login.working')} />
          </LoginPanel>
        </Stage>
      );
    }
    return (
      <LoginConsentDialog
        title={t('login.consentDialog.title')}
        body={t('login.consentDialog.body')}
        agreeLabel={t('login.consentDialog.agree')}
        disagreeLabel={t('login.consentDialog.disagree')}
        onAgree={noop}
        onDisagree={noop}
        onOpenTerms={noop}
        onOpenPrivacy={noop}
      />
    );
  },
});
