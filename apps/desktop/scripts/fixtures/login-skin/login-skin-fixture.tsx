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

const noop = () => {};
const statement = '我已阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私政策</privacy>';

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
            <LoginTitleBlock title="登录 Cindy" subtitle="输入邮箱，我们会给你发送验证码" />
            <LoginInput value="name@example.com" onChange={noop} placeholder="输入邮箱" testId="fixture-input" />
            <LoginPrimaryButton onClick={noop} testId="fixture-primary">继续</LoginPrimaryButton>
            <LoginSkipEntry onClick={noop}>跳过登录</LoginSkipEntry>
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
          <LoginConsentRow checked onToggle={noop} statement={statement} onOpenTerms={noop} onOpenPrivacy={noop} />
        </Stage>
      );
    }
    if (ctx.case === 'code') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginBackButton label="返回" onClick={noop} />
            <LoginTitleBlock title="输入验证码" subtitle="验证码已发送至 name@example.com" />
            <LoginInput value="" onChange={noop} placeholder="6 位验证码" testId="fixture-input" />
            <LoginTextLink onClick={noop} testId="fixture-link">重新发送验证码</LoginTextLink>
            <LoginPrimaryButton disabled onClick={noop}>登录</LoginPrimaryButton>
            <LoginErrorText>验证码错误，请重新输入</LoginErrorText>
          </LoginPanel>
        </Stage>
      );
    }
    if (ctx.case === 'method') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginBackButton label="返回" onClick={noop} />
            <LoginTitleBlock title="选择登录方式" subtitle="选择你习惯的方式继续" />
            <LoginMethodRow top={158} icon="person" title="个人账号" subtitle="使用邮箱或手机号登录" onClick={noop} testId="fixture-row" />
            <LoginMethodRow top={278} title="企业 SSO" subtitle="通过公司账号登录" onClick={noop} />
          </LoginPanel>
        </Stage>
      );
    }
    if (ctx.case === 'sso-history') {
      return (
        <Stage height={520}>
          <LoginPanel>
            <LoginTitleBlock title="企业 SSO" subtitle="输入组织标识" />
            <LoginInput value="example" onChange={noop} placeholder="组织标识" />
            <LoginPrimaryButton loading onClick={noop}>继续</LoginPrimaryButton>
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
            <LoginTitleBlock title="正在打开浏览器" subtitle="请在浏览器里完成登录" />
            <LoginLoadingRing y={158} label="加载中" />
          </LoginPanel>
        </Stage>
      );
    }
    return (
      <LoginConsentDialog
        title="服务条款与隐私政策"
        body="继续使用前，请阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私政策</privacy>。"
        agreeLabel="同意"
        disagreeLabel="不同意"
        onAgree={noop}
        onDisagree={noop}
        onOpenTerms={noop}
        onOpenPrivacy={noop}
      />
    );
  },
});
