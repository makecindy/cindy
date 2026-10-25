import { getMessages, type Locale } from './i18n.js';

const en = {
  phone: 'Phone number', addAccount: 'Add account', otherMethods: 'Other sign-in methods',
  organizationAccounts: 'Switch organization or personal account', refreshSession: 'Reconnect account',
  currentAccount: 'Current account', savedAccounts: 'Saved accounts', personal: 'Personal account',
  captcha: 'Verify you are human', captchaPaste: 'Paste the completed verification page address',
  captchaHelp: 'Complete verification in your browser, then paste its full address here.',
  unlockFirst: 'Unlock your credentials before signing in.', goUnlock: 'Open credential settings',
  wrongCode: 'The code could not be verified. Check it and try again.',
  rateLimited: 'Too many attempts. Wait before trying again.',
  expired: 'This sign-in attempt has expired. Start again.',
  failed: 'Sign-in could not be completed. Try again.',
  storage: 'Credentials could not be saved. Check the credential settings.',
  unavailable: 'This sign-in method is unavailable. Choose another method.',
  connection: 'The connection was interrupted. Check the connection and try again.',
  ssoMissing: 'No enterprise sign-in was found. Check the organization name.',
  blocked: 'Your organization requires enterprise sign-in.',
  stopTasks: 'Stop running tasks before changing accounts.',
  captchaInvalid: 'This verification address is not valid. Copy the full address from the completed page.',
  captchaFailed: 'Verification did not complete. Start a new verification.',
  cancelled: 'Sign-in was cancelled.', retryIn: 'Try again after', seconds: 's',
  mainlandChina: 'Mainland China', browserExpired: 'The authorization link has expired.',
  keyboard: '↑↓ select · Enter continue · Esc back', protectedInput: 'Input is hidden',
  noAccounts: 'No other accounts are available.', wechat: 'WeChat',
  sendCode: 'Send code',
};
type Extra = typeof en;

const translations: Record<Locale, Extra> = {
  en,
  'zh-CN': {
    phone:'手机号',addAccount:'添加账号',otherMethods:'其他登录方式',organizationAccounts:'切换组织或个人账号',refreshSession:'重新连接账号',
    currentAccount:'当前账号',savedAccounts:'已保存的账号',personal:'个人账号',captcha:'完成人机验证',captchaPaste:'粘贴验证完成后的完整网址',
    captchaHelp:'在浏览器中完成验证，再将页面的完整网址粘贴到这里。',unlockFirst:'请先解锁登录凭据。',goUnlock:'打开凭据设置',
    wrongCode:'验证码未通过，请核对后重试。',rateLimited:'尝试次数过多，请稍后再试。',expired:'本次登录已过期，请重新开始。',failed:'登录未完成，请重试。',
    storage:'登录凭据未能保存，请检查凭据设置。',unavailable:'此登录方式暂不可用，请选择其他方式。',connection:'连接中断，请检查网络后重试。',
    ssoMissing:'未找到企业登录，请核对组织名称。',blocked:'你的组织要求使用企业登录。',stopTasks:'请先停止运行中的任务，再切换账号。',
    captchaInvalid:'验证网址无效，请复制验证完成页面的完整网址。',captchaFailed:'验证未完成，请重新验证。',cancelled:'已取消登录。',
    retryIn:'请在以下时间后重试',seconds:'秒',mainlandChina:'中国大陆',browserExpired:'授权链接已过期。',keyboard:'↑↓ 选择 · Enter 继续 · Esc 返回',protectedInput:'输入内容已隐藏',
    noAccounts:'没有其他可用账号。',wechat:'微信',sendCode:'发送验证码',
  },
  'zh-TW': {
    phone:'手機號碼',addAccount:'新增帳號',otherMethods:'其他登入方式',organizationAccounts:'切換組織或個人帳號',refreshSession:'重新連線帳號',
    currentAccount:'目前帳號',savedAccounts:'已儲存的帳號',personal:'個人帳號',captcha:'完成人機驗證',captchaPaste:'貼上驗證完成後的完整網址',
    captchaHelp:'在瀏覽器中完成驗證，再將頁面的完整網址貼到這裡。',unlockFirst:'請先解鎖登入憑證。',goUnlock:'開啟憑證設定',
    wrongCode:'驗證碼未通過，請核對後重試。',rateLimited:'嘗試次數過多，請稍後再試。',expired:'本次登入已過期，請重新開始。',failed:'登入未完成，請重試。',
    storage:'登入憑證未能儲存，請檢查憑證設定。',unavailable:'此登入方式暫時無法使用，請選擇其他方式。',connection:'連線中斷，請檢查網路後重試。',
    ssoMissing:'找不到企業登入，請核對組織名稱。',blocked:'你的組織要求使用企業登入。',stopTasks:'請先停止執行中的任務，再切換帳號。',
    captchaInvalid:'驗證網址無效，請複製驗證完成頁面的完整網址。',captchaFailed:'驗證未完成，請重新驗證。',cancelled:'已取消登入。',
    retryIn:'請在以下時間後重試',seconds:'秒',mainlandChina:'中國大陸',browserExpired:'授權連結已過期。',keyboard:'↑↓ 選擇 · Enter 繼續 · Esc 返回',protectedInput:'輸入內容已隱藏',
    noAccounts:'沒有其他可用帳號。',wechat:'微信',sendCode:'傳送驗證碼',
  },
  ja: {
    phone:'電話番号',addAccount:'アカウントを追加',otherMethods:'別のログイン方法',organizationAccounts:'組織・個人アカウントを切り替え',refreshSession:'アカウントを再接続',
    currentAccount:'現在のアカウント',savedAccounts:'保存済みアカウント',personal:'個人アカウント',captcha:'人間であることを確認',captchaPaste:'認証完了ページの URL を貼り付け',
    captchaHelp:'ブラウザーで認証を完了し、ページの URL 全体をここに貼り付けてください。',unlockFirst:'ログイン前に認証情報のロックを解除してください。',goUnlock:'認証情報の設定を開く',
    wrongCode:'コードを確認できませんでした。確認して再試行してください。',rateLimited:'試行回数が多すぎます。しばらくしてから再試行してください。',expired:'ログインの有効期限が切れました。やり直してください。',failed:'ログインを完了できませんでした。再試行してください。',
    storage:'認証情報を保存できませんでした。認証情報の設定を確認してください。',unavailable:'このログイン方法は利用できません。別の方法を選んでください。',connection:'接続が中断されました。接続を確認して再試行してください。',
    ssoMissing:'企業ログインが見つかりません。組織名を確認してください。',blocked:'組織の企業ログインを使用してください。',stopTasks:'アカウントを切り替える前に実行中のセッションを停止してください。',
    captchaInvalid:'認証ページの URL が正しくありません。完了ページの URL 全体をコピーしてください。',captchaFailed:'認証が完了しませんでした。やり直してください。',cancelled:'ログインをキャンセルしました。',
    retryIn:'再試行まで',seconds:'秒',mainlandChina:'中国本土',browserExpired:'認証リンクの有効期限が切れました。',keyboard:'↑↓ 選択 · Enter 続行 · Esc 戻る',protectedInput:'入力内容は非表示です',
    noAccounts:'他のアカウントはありません。',wechat:'WeChat',sendCode:'コードを送信',
  },
  ko: {
    phone:'전화번호',addAccount:'계정 추가',otherMethods:'다른 로그인 방법',organizationAccounts:'조직 또는 개인 계정 전환',refreshSession:'계정 다시 연결',
    currentAccount:'현재 계정',savedAccounts:'저장된 계정',personal:'개인 계정',captcha:'사람인지 확인',captchaPaste:'인증 완료 페이지의 전체 주소 붙여넣기',
    captchaHelp:'브라우저에서 인증을 완료한 후 페이지의 전체 주소를 여기에 붙여넣으세요.',unlockFirst:'로그인하기 전에 인증 정보의 잠금을 해제하세요.',goUnlock:'인증 정보 설정 열기',
    wrongCode:'코드를 확인할 수 없습니다. 확인 후 다시 시도하세요.',rateLimited:'시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.',expired:'로그인 시도가 만료되었습니다. 다시 시작하세요.',failed:'로그인을 완료하지 못했습니다. 다시 시도하세요.',
    storage:'인증 정보를 저장하지 못했습니다. 인증 정보 설정을 확인하세요.',unavailable:'이 로그인 방법은 사용할 수 없습니다. 다른 방법을 선택하세요.',connection:'연결이 중단되었습니다. 연결을 확인하고 다시 시도하세요.',
    ssoMissing:'기업 로그인을 찾을 수 없습니다. 조직 이름을 확인하세요.',blocked:'조직에서 기업 로그인을 요구합니다.',stopTasks:'계정을 전환하기 전에 실행 중인 세션을 중지하세요.',
    captchaInvalid:'인증 주소가 올바르지 않습니다. 완료 페이지의 전체 주소를 복사하세요.',captchaFailed:'인증을 완료하지 못했습니다. 다시 인증하세요.',cancelled:'로그인이 취소되었습니다.',
    retryIn:'다시 시도하기까지',seconds:'초',mainlandChina:'중국 본토',browserExpired:'인증 링크가 만료되었습니다.',keyboard:'↑↓ 선택 · Enter 계속 · Esc 뒤로',protectedInput:'입력 내용이 숨겨집니다',
    noAccounts:'사용 가능한 다른 계정이 없습니다.',wechat:'WeChat',sendCode:'코드 보내기',
  },
};

export function authenticationText(locale: Locale) { return { ...getMessages(locale), ...translations[locale] }; }

export function authenticationError(code: string, locale: Locale): string {
  const t = authenticationText(locale);
  if (['USER_CANCELLED', 'AUTH_CANCELLED'].includes(code)) return t.cancelled;
  if (['INVALID_CODE', 'VERIFICATION_CODE_INVALID', 'INVALID_VERIFICATION_CODE', 'VERIFICATION_FAILED', 'CODE_INVALID'].includes(code)) return t.wrongCode;
  if (['RATE_LIMITED', 'TOO_MANY_REQUESTS', 'SEND_TOO_FREQUENT'].includes(code)) return t.rateLimited;
  if (['INVALID_AUTH_CODE', 'AUTHORIZATION_EXPIRED', 'REFRESH_TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'CAPTCHA_EXPIRED', 'CAPTCHA_ATTEMPT_INVALID', 'CODE_EXPIRED', 'VERIFICATION_CODE_EXPIRED'].includes(code)) return t.expired;
  if (code === 'CAPTCHA_RETURN_INVALID') return t.captchaInvalid;
  if (code.startsWith('CAPTCHA_')) return t.captchaFailed;
  if (['VAULT_LOCKED', 'VAULT_NOT_INITIALIZED', 'CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_INVALID'].includes(code)) return t.storage;
  if (['HOSTED_CALLBACK_UNAVAILABLE', 'EMAIL_LOGIN_DISABLED', 'PHONE_LOGIN_DISABLED', 'INVALID_AUTH_CONFIGURATION'].includes(code)) return t.unavailable;
  if (['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'AUTH_REQUEST_FAILED', 'CONNECTION_CLOSED', 'SERVICE_UNAVAILABLE'].includes(code)) return t.connection;
  if (code === 'ORG_SSO_NOT_FOUND') return t.ssoMissing;
  if (code === 'SSO_REQUIRED') return t.blocked;
  if (code === 'STOP_RUNNING_TASKS_BEFORE_ACCOUNT_CHANGE') return t.stopTasks;
  return t.failed;
}
