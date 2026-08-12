/**
 * RSB WebAuthn 原生账户选择框的四语文案。
 *
 * 这份 catalog 不走 renderer i18next，单独成模块是为了让主进程测试能够在
 * 不加载 Electron 启动入口的前提下执行术语与标点门禁。
 */
import type { SupportedLocale } from '../shared/locale.js';

export interface RsbBrowserWebAuthnLabels {
  title: string;
  message: string;
  detail: string;
  cancel: string;
  unknownAccount: string;
  unknownRelyingParty: string;
  touchIdPromptReason: string;
}

export const RSB_BROWSER_WEBAUTHN_LABELS: Record<
  SupportedLocale,
  RsbBrowserWebAuthnLabels
> = {
  'zh-CN': {
    title: '选择通行密钥',
    message: '选择用于 {{relyingPartyId}} 的通行密钥',
    detail: 'Cindy 只会把你的选择交给认证器；通行密钥的私密信息始终留在认证器中。',
    cancel: '取消通行密钥登录',
    unknownAccount: '通行密钥 {{index}}',
    unknownRelyingParty: '此网站',
    touchIdPromptReason: '在 $1 验证你的身份',
  },
  'zh-TW': {
    title: '選擇通行密鑰',
    message: '選擇用於 {{relyingPartyId}} 的通行密鑰',
    detail: 'Cindy 只會將你的選擇交給驗證器；通行密鑰的私密資訊始終留在驗證器中。',
    cancel: '取消通行密鑰登入',
    unknownAccount: '通行密鑰 {{index}}',
    unknownRelyingParty: '此網站',
    touchIdPromptReason: '在 $1 驗證你的身分',
  },
  en: {
    title: 'Choose a Passkey',
    message: 'Choose a passkey for {{relyingPartyId}}',
    detail:
      'Cindy only passes your selection to the authenticator; the passkey secret stays in the authenticator.',
    cancel: 'Cancel Passkey Sign-In',
    unknownAccount: 'Passkey {{index}}',
    unknownRelyingParty: 'this website',
    touchIdPromptReason: 'verify your identity on $1',
  },
  ja: {
    title: 'パスキーを選択',
    message: '{{relyingPartyId}} で使用するパスキーを選択',
    detail:
      'Cindy は選択内容のみを認証器に渡します。パスキーの秘密情報は常に認証器内に保持されます。',
    cancel: 'パスキーでのサインインをキャンセル',
    unknownAccount: 'パスキー {{index}}',
    unknownRelyingParty: 'このウェブサイト',
    touchIdPromptReason: '$1 で本人確認を行う',
  },
  ko: {
    title: '패스키 선택',
    message: '{{relyingPartyId}}에 사용할 패스키 선택',
    detail:
      'Cindy는 선택 내용만 인증 장치에 전달하며, 패스키의 비밀 정보는 항상 인증 장치에 남아 있습니다.',
    cancel: '패스키 로그인 취소',
    unknownAccount: '패스키 {{index}}',
    unknownRelyingParty: '이 웹사이트',
    touchIdPromptReason: '$1에서 본인 확인',
  },
};
