import { getLocales } from "expo-localization";

import { getManualLocaleOverride } from "@/i18n/appLanguage";

/**
 * 登录域多语文案 catalog(zh-CN/zh-TW/en/ja/ko)。
 * 生效语言 = 设置里手动选择的语言(appLanguage override)优先,否则按系统
 * locale 解析:zh-Hant/TW/HK/MO → zh-TW，zh-Hans/CN/SG → zh-CN;
 * ja → ja,ko → ko,兜底 en。
 * catalog 必须保持单一 messages 常量、locale 块内联的普通对象字面量形态——
 * check-login-i18n-parity.mjs 靠结构化 tokenizer 静态提取 locale/key 集合,
 * 拆常量或改引用形态会让 parity 门失效。
 */
export type LoginLocale = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";

const messages = {
  "zh-TW": {
    title: "登入 Cindy",
    phonePlaceholder: "輸入手機號",
    emailPlaceholder: "輸入電子郵件地址",
    invalidEmail: "請輸入正確的電子郵件地址",
    invalidPhone: "請輸入正確手機號",
    continue: "繼續",
    apple: "通過 Apple 繼續",
    google: "通過 Google 繼續",
    wechat: "通過微信繼續",
    chooseMethod: "選擇登入方式",
    orgDetected: "{email} 屬於企業「{org}」",
    enterpriseLogin: "以企業身分登入",
    personalLogin: "以個人身分登入",
    emailCode: "傳送電子郵件驗證碼",
    ssoRequired: "該組織要求使用企業 SSO 登入。",
    ssoEntry: "使用企業 SSO 登入",
    consentStatement:
      "我已閱讀並同意 <terms>服務條款</terms> 和 <privacy>隱私政策</privacy>",
    consentDialogTitle: "服務條款和隱私政策",
    consentDialogBody:
      "請閱讀並同意 Cindy 的以下協議後繼續：<terms>服務條款</terms>、<privacy>隱私政策</privacy>",
    consentAgree: "同意",
    consentDisagree: "暫不同意",
    ssoOrgTitle: "企業 SSO 登入",
    ssoOrgSubtitle: "輸入企業 ID、組織 slug 或已驗證域名，跳轉到企業單點登入。",
    ssoOrgPlaceholder: "企業 ID、slug 或域名",
    ssoOrgHint: "不知道企業登入標識？請聯絡企業管理員。",
    ssoOrgDetected: "選擇企業「{org}」的單點登入方式",
    realmConsentTitle: "連線企業所在區域",
    realmConsentBodyCn:
      "你的企業位於中國大陸區。\n繼續後，Cindy 會連線該區域。",
    realmConsentBodyGlobal:
      "你的企業位於國際區。\n繼續後，Cindy 會連線該區域。",
    realmConsentAgree: "繼續登入",
    realmConsentDisagree: "取消",
    ssoVerificationTitle: "驗證企業聯絡方式",
    ssoVerificationSubtitle:
      "首次登入需要驗證身分提供方返回的聯絡方式 {target}。",
    enterCode: "輸入驗證碼",
    codeSentTo: "驗證碼已傳送至",
    codePlaceholder: "6 位驗證碼",
    signIn: "登入",
    resendCode: "重新發送驗證碼",
    resendCountdown: "{n} 秒後可重新發送",
    chooseAccount: "選擇身分",
    chooseAccountSubtitle: "選擇本次要進入的個人或組織身分。",
    personalAccount: "個人身分",
    bindPhoneTitle: "綁定手機號碼",
    bindPhoneSubtitle: "需要驗證手機號後才能完成登入。",
    bindEmailTitle: "綁定真實電子郵件",
    bindEmailSubtitle: "需要驗證真實電子郵件後才能完成登入。",
    sendCode: "傳送驗證碼",
    back: "返回",
    cancel: "取消",
    browserTitle: "請在瀏覽器中完成登入",
    browserSubtitle: "完成後會自動返回 Cindy。",
    working: "處理中…",
    configTitle: "登入設定未完成",
    accountDeletionPendingTitle: "帳號正在等待刪除",
    accountDeletionProcessingTitle: "帳號正在刪除",
    accountDeletionCompletedTitle: "帳號已刪除",
    accountDeletionPendingCopy:
      "預計於 {date} 永久刪除。現在重新登入即可取消刪除。",
    accountDeletionProcessingCopy:
      "Cindy 登入帳號正在刪除，處理完成後將永久刪除。",
    accountDeletionCompletedCopy: "Cindy 登入帳號已刪除。",
    accountDeletionDismiss: "我知道了",
    accountDeletionSettingsAction: "刪除帳號",
    accountDeletionScreenTitle: "刪除帳號",
    accountDeletionLoading: "正在確認帳號狀態…",
    accountDeletionUnavailableTitle: "當前無法進行此操作",
    accountDeletionUnavailableCopy: "請返回設定頁稍後重試。",
    accountDeletionVerifyTitle: "驗證帳號所有權",
    accountDeletionCodeSent: "驗證碼已傳送至 {target}，10 分鐘內有效。",
    accountDeletionAcknowledgeA11y: "確認瞭解刪除帳號的影響",
    accountDeletionAcknowledgeCopy:
      "我已瞭解：這臺手機會立即登出；其他客戶端會在登入狀態失效後登出；30 天內重新登入可撤銷刪除；到期後 Cindy 登入帳號將永久刪除且無法恢復。",
    accountDeletionConfirmingA11y: "正在確認刪除帳號",
    accountDeletionConfirmA11y: "確認刪除帳號",
    accountDeletionConfirming: "確認中",
    accountDeletionConfirm: "確認刪除帳號",
    accountDeletionBeforeTitle: "刪除前請確認",
    accountDeletionImpactCurrentClient:
      "確認後，這臺手機立即退出；其他客戶端會在登入狀態失效後退出。",
    accountDeletionImpactGrace:
      "帳號進入 30 天等待期；期間重新登入即可取消刪除。",
    accountDeletionImpactPermanent:
      "等待期結束後，Cindy 登入帳號將被永久刪除。",
    accountDeletionAppleNotice:
      "使用 Apple 登入的授權可能需要你在 Apple ID 設定中手動停止使用 Cindy。",
    accountDeletionCodeWillSend: "驗證碼將傳送至 {target}。",
    accountDeletionSendingCode: "傳送中",
    accountDeletionErrorChallenge: "驗證碼錯誤或已過期，請檢查後重試。",
    accountDeletionErrorAttempts: "驗證次數過多，請重新發送驗證碼。",
    accountDeletionErrorRate: "操作過於頻繁，請稍後再試。",
    accountDeletionErrorPending: "帳號已進入刪除等待期。",
    accountDeletionErrorProcessing: "帳號正在刪除處理中。",
    accountDeletionErrorUnavailable: "當前無法進行此操作。",
    accountDeletionErrorNetwork: "網路連線異常，請稍後重試。",
    accountDeletionErrorFallback: "操作未完成，請稍後重試。",
    accountDeletionRestoredTitle: "帳號已恢復",
    accountDeletionRestoredCopy:
      "本次登入已取消刪除帳號，Cindy 登入帳號將繼續保留。",
    errorFallback: "登入未完成，請重試。",
    endpointGateTitle: "無法取得伺服器設定",
    endpointGateSubtitle: "請檢查網路連線後重試({reason})",
    retry: "重試",
    configIssueAuthBaseUrl: "登入服務地址必須是 http(s) URL。",
  },
  "zh-CN": {
    title: "登录 Cindy",
    phonePlaceholder: "输入手机号",
    emailPlaceholder: "输入邮箱地址",
    invalidEmail: "请输入正确邮箱",
    invalidPhone: "请输入正确手机号",
    continue: "继续",
    apple: "通过 Apple 继续",
    google: "通过 Google 继续",
    wechat: "通过微信继续",
    chooseMethod: "选择登录方式",
    orgDetected: "{email} 属于企业「{org}」",
    enterpriseLogin: "以企业身份登录",
    personalLogin: "以个人身份登录",
    emailCode: "发送邮箱验证码",
    ssoRequired: "该组织要求使用企业 SSO 登录。",
    ssoEntry: "使用企业 SSO 登录",
    consentStatement:
      "我已阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私协议</privacy>",
    consentDialogTitle: "服务条款和隐私协议",
    consentDialogBody:
      "请阅读并同意 Cindy 的以下协议后继续：<terms>服务条款</terms>、<privacy>隐私协议</privacy>",
    consentAgree: "同意",
    consentDisagree: "暂不同意",
    ssoOrgTitle: "企业 SSO 登录",
    ssoOrgSubtitle: "输入企业 ID、组织 slug 或已验证域名，跳转到企业单点登录。",
    ssoOrgPlaceholder: "企业 ID、slug 或域名",
    ssoOrgHint: "不知道企业登录标识？请联系企业管理员。",
    ssoOrgDetected: "选择企业「{org}」的单点登录方式",
    realmConsentTitle: "连接企业所在区域",
    realmConsentBodyCn:
      "你的企业位于中国大陆区。\n继续后，Cindy 会连接该区域。",
    realmConsentBodyGlobal:
      "你的企业位于国际区。\n继续后，Cindy 会连接该区域。",
    realmConsentAgree: "继续登录",
    realmConsentDisagree: "取消",
    ssoVerificationTitle: "验证企业联系方式",
    ssoVerificationSubtitle:
      "首次登录需要验证身份提供方返回的联系方式 {target}。",
    enterCode: "输入验证码",
    codeSentTo: "验证码已发送至",
    codePlaceholder: "6 位验证码",
    signIn: "登录",
    resendCode: "重新发送验证码",
    resendCountdown: "{n} 秒后可重新发送",
    chooseAccount: "选择身份",
    chooseAccountSubtitle: "选择本次要进入的个人或组织身份。",
    personalAccount: "个人身份",
    bindPhoneTitle: "绑定手机号",
    bindPhoneSubtitle: "需要验证手机号后才能完成登录。",
    bindEmailTitle: "绑定真实邮箱",
    bindEmailSubtitle: "需要验证真实邮箱后才能完成登录。",
    sendCode: "发送验证码",
    back: "返回",
    cancel: "取消",
    browserTitle: "请在浏览器中完成登录",
    browserSubtitle: "完成后会自动返回 Cindy。",
    working: "处理中…",
    configTitle: "登录配置未完成",
    accountDeletionPendingTitle: "账号正在等待注销",
    accountDeletionProcessingTitle: "账号正在注销",
    accountDeletionCompletedTitle: "账号已注销",
    accountDeletionPendingCopy:
      "预计于 {date} 永久删除。现在重新登录即可取消注销。",
    accountDeletionProcessingCopy:
      "Cindy 登录账号正在删除，处理完成后将永久注销。",
    accountDeletionCompletedCopy: "Cindy 登录账号已删除。",
    accountDeletionDismiss: "我知道了",
    accountDeletionSettingsAction: "注销账号",
    accountDeletionScreenTitle: "注销账号",
    accountDeletionLoading: "正在确认账号状态…",
    accountDeletionUnavailableTitle: "当前无法进行此操作",
    accountDeletionUnavailableCopy: "请返回设置页稍后重试。",
    accountDeletionVerifyTitle: "验证账号所有权",
    accountDeletionCodeSent: "验证码已发送至 {target}，10 分钟内有效。",
    accountDeletionAcknowledgeA11y: "确认了解账号注销影响",
    accountDeletionAcknowledgeCopy:
      "我已了解：这台手机会立即退出；其他客户端会在登录状态失效后退出；30 天内重新登录可撤销；到期后 Cindy 登录账号将永久删除且无法恢复。",
    accountDeletionConfirmingA11y: "正在确认注销",
    accountDeletionConfirmA11y: "确认注销账号",
    accountDeletionConfirming: "确认中",
    accountDeletionConfirm: "确认注销账号",
    accountDeletionBeforeTitle: "注销前请确认",
    accountDeletionImpactCurrentClient:
      "确认后，这台手机立即退出；其他客户端会在登录状态失效后退出。",
    accountDeletionImpactGrace:
      "账号进入 30 天等待期；期间重新登录即可取消注销。",
    accountDeletionImpactPermanent:
      "等待期结束后，Cindy 登录账号将被永久删除。",
    accountDeletionAppleNotice:
      "使用 Apple 登录的授权可能需要你在 Apple ID 设置中手动停止使用 Cindy。",
    accountDeletionCodeWillSend: "验证码将发送至 {target}。",
    accountDeletionSendingCode: "发送中",
    accountDeletionErrorChallenge: "验证码错误或已过期，请检查后重试。",
    accountDeletionErrorAttempts: "验证次数过多，请重新发送验证码。",
    accountDeletionErrorRate: "操作过于频繁，请稍后再试。",
    accountDeletionErrorPending: "账号已进入注销等待期。",
    accountDeletionErrorProcessing: "账号正在注销处理中。",
    accountDeletionErrorUnavailable: "当前无法进行此操作。",
    accountDeletionErrorNetwork: "网络连接异常，请稍后重试。",
    accountDeletionErrorFallback: "操作未完成，请稍后重试。",
    accountDeletionRestoredTitle: "账号已恢复",
    accountDeletionRestoredCopy:
      "本次登录已取消账号注销，Cindy 登录账号将继续保留。",
    errorFallback: "登录未完成，请重试。",
    endpointGateTitle: "无法获取服务器配置",
    endpointGateSubtitle: "请检查网络连接后重试({reason})",
    retry: "重试",
    configIssueAuthBaseUrl: "登录服务地址必须是 http(s) URL。",
  },
  en: {
    title: "Sign in to Cindy",
    phonePlaceholder: "Phone number",
    emailPlaceholder: "Email address",
    invalidEmail: "Please enter a valid email address",
    invalidPhone: "Please enter a valid phone number",
    continue: "Continue",
    apple: "Continue with Apple",
    google: "Continue with Google",
    wechat: "Continue with WeChat",
    chooseMethod: "Choose a sign-in method",
    orgDetected: '{email} belongs to "{org}"',
    enterpriseLogin: "Sign in with your work identity",
    personalLogin: "Sign in with a personal account",
    emailCode: "Send an email code",
    ssoRequired: "Your organization requires enterprise SSO.",
    ssoEntry: "Sign in with enterprise SSO",
    consentStatement:
      "I have read and agree to the <terms>Terms of Service</terms> and <privacy>Privacy Policy</privacy>",
    consentDialogTitle: "Terms of Service & Privacy Policy",
    consentDialogBody:
      "Read and agree to Cindy's <terms>Terms of Service</terms> and <privacy>Privacy Policy</privacy> to continue.",
    consentAgree: "Agree",
    consentDisagree: "Not Now",
    ssoOrgTitle: "Enterprise SSO",
    ssoOrgSubtitle:
      "Enter a company ID, organization slug, or verified domain to continue with single sign-on.",
    ssoOrgPlaceholder: "Company ID, slug, or domain",
    ssoOrgHint:
      "Don't know your enterprise sign-in identifier? Ask your admin.",
    ssoOrgDetected: 'Choose a single sign-on connection for "{org}"',
    realmConsentTitle: "Connect to your enterprise region",
    realmConsentBodyCn:
      "Your enterprise is in Mainland China.\nContinue to connect Cindy to this region.",
    realmConsentBodyGlobal:
      "Your enterprise is in the Global region.\nContinue to connect Cindy to this region.",
    realmConsentAgree: "Continue sign-in",
    realmConsentDisagree: "Cancel",
    ssoVerificationTitle: "Verify your work identity",
    ssoVerificationSubtitle:
      "First-time sign-in requires verification of the contact returned by your identity provider: {target}.",
    enterCode: "Enter verification code",
    codeSentTo: "We sent a code to",
    codePlaceholder: "6-digit code",
    signIn: "Sign in",
    resendCode: "Resend code",
    resendCountdown: "Resend available in {n}s",
    chooseAccount: "Choose an account",
    chooseAccountSubtitle:
      "Choose the personal or organization account to use.",
    personalAccount: "Personal account",
    bindPhoneTitle: "Verify your phone",
    bindPhoneSubtitle:
      "A verified phone number is required to finish signing in.",
    bindEmailTitle: "Verify your email",
    bindEmailSubtitle:
      "A verified email address is required to finish signing in.",
    sendCode: "Send code",
    back: "Back",
    cancel: "Cancel",
    browserTitle: "Finish signing in in your browser",
    browserSubtitle: "You will return to Cindy automatically.",
    working: "Working…",
    configTitle: "Sign-in configuration is incomplete",
    accountDeletionPendingTitle: "Account scheduled for deletion",
    accountDeletionProcessingTitle: "Account deletion in progress",
    accountDeletionCompletedTitle: "Account deleted",
    accountDeletionPendingCopy:
      "Scheduled for permanent deletion on {date}. Sign in now to cancel deletion.",
    accountDeletionProcessingCopy:
      "Your Cindy sign-in account is being deleted and will be permanently deleted when processing is complete.",
    accountDeletionCompletedCopy:
      "Your Cindy sign-in account has been deleted.",
    accountDeletionDismiss: "Got it",
    accountDeletionSettingsAction: "Delete account",
    accountDeletionScreenTitle: "Delete account",
    accountDeletionLoading: "Checking account status…",
    accountDeletionUnavailableTitle: "This action is unavailable",
    accountDeletionUnavailableCopy: "Return to Settings and try again later.",
    accountDeletionVerifyTitle: "Verify account ownership",
    accountDeletionCodeSent:
      "We sent a code to {target}. It is valid for 10 minutes.",
    accountDeletionAcknowledgeA11y:
      "Acknowledge the effects of account deletion",
    accountDeletionAcknowledgeCopy:
      "I understand: this phone will sign out immediately; other clients will sign out when their sign-in session becomes invalid; signing in within 30 days cancels deletion; after that, the Cindy sign-in account is permanently deleted and cannot be recovered.",
    accountDeletionConfirmingA11y: "Confirming account deletion",
    accountDeletionConfirmA11y: "Confirm account deletion",
    accountDeletionConfirming: "Confirming",
    accountDeletionConfirm: "Delete account",
    accountDeletionBeforeTitle: "Before deleting your account",
    accountDeletionImpactCurrentClient:
      "This phone signs out immediately. Other clients sign out when their sign-in session becomes invalid.",
    accountDeletionImpactGrace:
      "The account enters a 30-day waiting period. Signing in during this period cancels deletion.",
    accountDeletionImpactPermanent:
      "After the waiting period, the Cindy sign-in account is permanently deleted.",
    accountDeletionAppleNotice:
      "If you use Sign in with Apple, you may also need to stop using Cindy in your Apple ID settings.",
    accountDeletionCodeWillSend: "We will send a code to {target}.",
    accountDeletionSendingCode: "Sending",
    accountDeletionErrorChallenge:
      "The verification code is incorrect or expired. Try again.",
    accountDeletionErrorAttempts:
      "Too many verification attempts. Send a new code.",
    accountDeletionErrorRate: "Too many requests. Try again later.",
    accountDeletionErrorPending:
      "The account is already scheduled for deletion.",
    accountDeletionErrorProcessing: "Account deletion is already in progress.",
    accountDeletionErrorUnavailable: "This action is currently unavailable.",
    accountDeletionErrorNetwork: "Check your connection and try again.",
    accountDeletionErrorFallback:
      "The action did not complete. Try again later.",
    accountDeletionRestoredTitle: "Account restored",
    accountDeletionRestoredCopy:
      "This sign-in canceled account deletion. Your Cindy sign-in account will be kept.",
    errorFallback: "Sign-in did not complete. Please try again.",
    endpointGateTitle: "Unable to load server configuration",
    endpointGateSubtitle:
      "Check your network connection and try again ({reason})",
    retry: "Retry",
    configIssueAuthBaseUrl:
      "The sign-in service address must be an http(s) URL.",
  },
  ja: {
    title: "Cindy にログイン",
    phonePlaceholder: "携帯電話番号",
    emailPlaceholder: "メールアドレスを入力",
    invalidEmail: "正しいメールアドレスを入力してください",
    invalidPhone: "正しい電話番号を入力してください",
    continue: "続行",
    apple: "Apple で続行",
    google: "Google で続行",
    wechat: "WeChat で続行",
    chooseMethod: "ログイン方法を選択",
    orgDetected: "{email} は組織「{org}」に属しています",
    enterpriseLogin: "組織アカウントでログイン",
    personalLogin: "個人アカウントでログイン",
    emailCode: "メールで認証コードを送信",
    ssoRequired: "この組織ではエンタープライズ SSO でのログインが必須です。",
    ssoEntry: "エンタープライズ SSO でログイン",
    consentStatement:
      "<terms>利用規約</terms>と<privacy>プライバシーポリシー</privacy>を読み、同意します",
    consentDialogTitle: "利用規約とプライバシーポリシー",
    consentDialogBody:
      "続行するには、Cindyの<terms>利用規約</terms>と<privacy>プライバシーポリシー</privacy>を確認し、同意してください。",
    consentAgree: "同意する",
    consentDisagree: "同意しない",
    ssoOrgTitle: "エンタープライズ SSO",
    ssoOrgSubtitle:
      "会社 ID、組織 slug、または確認済みドメインを入力すると、所属組織のシングルサインオンに進みます。",
    ssoOrgPlaceholder: "会社 ID、slug、またはドメイン",
    ssoOrgHint:
      "企業のログイン識別子が不明な場合は、管理者にお問い合わせください。",
    ssoOrgDetected: "組織「{org}」のシングルサインオン方法を選択",
    realmConsentTitle: "企業のリージョンに接続",
    realmConsentBodyCn:
      "この企業は中国本土リージョンにあります。\n続行すると Cindy はこの地域に接続します。",
    realmConsentBodyGlobal:
      "この企業はグローバルリージョンにあります。\n続行すると Cindy はこの地域に接続します。",
    realmConsentAgree: "ログインを続ける",
    realmConsentDisagree: "キャンセル",
    ssoVerificationTitle: "企業の連絡先を確認",
    ssoVerificationSubtitle:
      "初回ログイン時、IdP が返した連絡先 {target} の確認が必要です。",
    enterCode: "認証コードを入力",
    codeSentTo: "認証コードの送信先:",
    codePlaceholder: "6桁の認証コード",
    signIn: "ログイン",
    resendCode: "認証コードを再送信",
    resendCountdown: "{n} 秒後に再送信できます",
    chooseAccount: "アカウントを選択",
    chooseAccountSubtitle:
      "使用する個人または組織のアカウントを選択してください。",
    personalAccount: "個人アカウント",
    bindPhoneTitle: "電話番号を認証",
    bindPhoneSubtitle: "ログインを完了するには電話番号の認証が必要です。",
    bindEmailTitle: "メールアドレスを認証",
    bindEmailSubtitle: "ログインを完了するにはメールアドレスの認証が必要です。",
    sendCode: "認証コードを送信",
    back: "戻る",
    cancel: "キャンセル",
    browserTitle: "ブラウザでログインを完了してください",
    browserSubtitle: "完了すると自動的に Cindy に戻ります。",
    working: "処理中…",
    configTitle: "ログイン設定が未完了です",
    accountDeletionPendingTitle: "アカウントは削除待機中です",
    accountDeletionProcessingTitle: "アカウントを削除処理中です",
    accountDeletionCompletedTitle: "アカウントを削除しました",
    accountDeletionPendingCopy:
      "{date} に完全に削除される予定です。今すぐ再ログインすると削除を取り消せます。",
    accountDeletionProcessingCopy:
      "Cindy ログインアカウントを削除しています。処理が完了すると完全に削除されます。",
    accountDeletionCompletedCopy: "Cindy ログインアカウントは削除されました。",
    accountDeletionDismiss: "了解しました",
    accountDeletionSettingsAction: "アカウントを削除",
    accountDeletionScreenTitle: "アカウントを削除",
    accountDeletionLoading: "アカウントの状態を確認しています…",
    accountDeletionUnavailableTitle: "この操作は現在利用できません",
    accountDeletionUnavailableCopy:
      "設定画面に戻って、後でもう一度お試しください。",
    accountDeletionVerifyTitle: "アカウントの所有権を確認",
    accountDeletionCodeSent:
      "認証コードを {target} に送信しました。10 分間有効です。",
    accountDeletionAcknowledgeA11y: "アカウント削除の影響を理解したことを確認",
    accountDeletionAcknowledgeCopy:
      "理解しています：この端末はすぐにログアウトします。他のクライアントはログイン状態が無効になった後にログアウトします。30 日以内に再ログインすれば取り消せます。期限が過ぎると Cindy ログインアカウントは完全に削除され、復元できません。",
    accountDeletionConfirmingA11y: "アカウント削除を確認しています",
    accountDeletionConfirmA11y: "アカウント削除を確認",
    accountDeletionConfirming: "確認中",
    accountDeletionConfirm: "アカウントを削除",
    accountDeletionBeforeTitle: "アカウントを削除する前に",
    accountDeletionImpactCurrentClient:
      "この端末はすぐにログアウトします。他のクライアントはログイン状態が無効になった後にログアウトします。",
    accountDeletionImpactGrace:
      "アカウントは 30 日間の待機期間に入ります。この期間に再ログインすると削除を取り消せます。",
    accountDeletionImpactPermanent:
      "待機期間が終了すると、Cindy ログインアカウントは完全に削除されます。",
    accountDeletionAppleNotice:
      "Apple でサインインを利用している場合は、Apple ID の設定で Cindy の利用停止を手動で行う必要がある場合があります。",
    accountDeletionCodeWillSend: "認証コードを {target} に送信します。",
    accountDeletionSendingCode: "送信中",
    accountDeletionErrorChallenge:
      "認証コードが正しくないか、有効期限が切れています。確認して再試行してください。",
    accountDeletionErrorAttempts:
      "認証の試行回数が多すぎます。認証コードを再送信してください。",
    accountDeletionErrorRate:
      "操作が頻繁すぎます。しばらくしてからお試しください。",
    accountDeletionErrorPending:
      "アカウントはすでに削除待機期間に入っています。",
    accountDeletionErrorProcessing: "アカウントの削除処理はすでに進行中です。",
    accountDeletionErrorUnavailable: "この操作は現在利用できません。",
    accountDeletionErrorNetwork:
      "ネットワーク接続に問題があります。しばらくしてからお試しください。",
    accountDeletionErrorFallback:
      "操作が完了しませんでした。しばらくしてからお試しください。",
    accountDeletionRestoredTitle: "アカウントを復元しました",
    accountDeletionRestoredCopy:
      "今回のログインでアカウント削除を取り消しました。Cindy ログインアカウントは引き続き保持されます。",
    errorFallback: "ログインが完了しませんでした。もう一度お試しください。",
    endpointGateTitle: "サーバー設定を取得できません",
    endpointGateSubtitle:
      "ネットワーク接続を確認してから再試行してください({reason})",
    retry: "再試行",
    configIssueAuthBaseUrl:
      "ログインサービスのアドレスは http(s) URL である必要があります。",
  },
  ko: {
    title: "Cindy 로그인",
    phonePlaceholder: "휴대전화 번호",
    emailPlaceholder: "이메일 주소 입력",
    invalidEmail: "올바른 이메일 주소를 입력하세요",
    invalidPhone: "올바른 전화번호를 입력하세요",
    continue: "계속",
    apple: "Apple로 계속",
    google: "Google로 계속",
    wechat: "WeChat으로 계속",
    chooseMethod: "로그인 방법 선택",
    orgDetected: '{email}은(는) "{org}" 소속입니다',
    enterpriseLogin: "회사 계정으로 로그인",
    personalLogin: "개인 계정으로 로그인",
    emailCode: "이메일 인증 코드 보내기",
    ssoRequired: "이 조직은 기업 SSO 로그인을 요구합니다.",
    ssoEntry: "기업 SSO로 로그인",
    consentStatement:
      "<terms>서비스 이용약관</terms> 및 <privacy>개인정보 처리방침</privacy>을 읽고 동의합니다",
    consentDialogTitle: "서비스 이용약관 및 개인정보 처리방침",
    consentDialogBody:
      "계속하려면 Cindy의 <terms>서비스 이용약관</terms> 및 <privacy>개인정보 처리방침</privacy>을 읽고 동의해 주세요.",
    consentAgree: "동의",
    consentDisagree: "동의 안 함",
    ssoOrgTitle: "기업 SSO 로그인",
    ssoOrgSubtitle:
      "회사 ID, 조직 slug 또는 인증된 도메인을 입력하면 소속 조직의 SSO 로그인으로 이동합니다.",
    ssoOrgPlaceholder: "회사 ID, slug 또는 도메인",
    ssoOrgHint: "기업 로그인 식별자를 모르시나요? 관리자에게 문의하세요.",
    ssoOrgDetected: '"{org}" 조직의 SSO 연결을 선택하세요',
    realmConsentTitle: "기업 지역에 연결",
    realmConsentBodyCn:
      "이 기업은 중국 본토 지역에 있습니다.\n계속하면 Cindy가 해당 지역에 연결됩니다.",
    realmConsentBodyGlobal:
      "이 기업은 글로벌 지역에 있습니다.\n계속하면 Cindy가 해당 지역에 연결됩니다.",
    realmConsentAgree: "로그인 계속",
    realmConsentDisagree: "취소",
    ssoVerificationTitle: "기업 신원 확인",
    ssoVerificationSubtitle:
      "최초 로그인 시 ID 공급자가 반환한 연락처 {target} 확인이 필요합니다.",
    enterCode: "인증 코드 입력",
    codeSentTo: "인증 코드 전송 대상:",
    codePlaceholder: "6자리 인증 코드",
    signIn: "로그인",
    resendCode: "인증 코드 재전송",
    resendCountdown: "{n}초 후 재전송 가능",
    chooseAccount: "계정 선택",
    chooseAccountSubtitle: "사용할 개인 또는 조직 계정을 선택하세요.",
    personalAccount: "개인 계정",
    bindPhoneTitle: "전화번호 인증",
    bindPhoneSubtitle: "로그인을 완료하려면 전화번호 인증이 필요합니다.",
    bindEmailTitle: "이메일 인증",
    bindEmailSubtitle: "로그인을 완료하려면 이메일 인증이 필요합니다.",
    sendCode: "인증 코드 보내기",
    back: "뒤로",
    cancel: "취소",
    browserTitle: "브라우저에서 로그인을 완료하세요",
    browserSubtitle: "완료되면 자동으로 Cindy로 돌아갑니다.",
    working: "처리 중…",
    configTitle: "로그인 설정이 완료되지 않았습니다",
    accountDeletionPendingTitle: "계정이 삭제 대기 중입니다",
    accountDeletionProcessingTitle: "계정을 삭제하는 중입니다",
    accountDeletionCompletedTitle: "계정이 삭제되었습니다",
    accountDeletionPendingCopy:
      "{date}에 영구 삭제될 예정입니다. 지금 다시 로그인하면 삭제를 취소할 수 있습니다.",
    accountDeletionProcessingCopy:
      "Cindy 로그인 계정을 삭제하고 있습니다. 처리가 완료되면 영구적으로 삭제됩니다.",
    accountDeletionCompletedCopy: "Cindy 로그인 계정이 삭제되었습니다.",
    accountDeletionDismiss: "확인",
    accountDeletionSettingsAction: "계정 삭제",
    accountDeletionScreenTitle: "계정 삭제",
    accountDeletionLoading: "계정 상태를 확인하는 중…",
    accountDeletionUnavailableTitle: "현재 이 작업을 사용할 수 없습니다",
    accountDeletionUnavailableCopy:
      "설정 화면으로 돌아가 나중에 다시 시도해 주세요.",
    accountDeletionVerifyTitle: "계정 소유권 확인",
    accountDeletionCodeSent:
      "인증 코드를 {target}(으)로 보냈습니다. 10분간 유효합니다.",
    accountDeletionAcknowledgeA11y: "계정 삭제의 영향을 이해했음을 확인",
    accountDeletionAcknowledgeCopy:
      "이해합니다: 이 기기는 즉시 로그아웃됩니다. 다른 클라이언트는 로그인 상태가 무효화된 후 로그아웃됩니다. 30일 이내에 다시 로그인하면 취소할 수 있습니다. 기한이 지나면 Cindy 로그인 계정은 영구적으로 삭제되며 복구할 수 없습니다.",
    accountDeletionConfirmingA11y: "계정 삭제를 확인하는 중",
    accountDeletionConfirmA11y: "계정 삭제 확인",
    accountDeletionConfirming: "확인 중",
    accountDeletionConfirm: "계정 삭제",
    accountDeletionBeforeTitle: "계정을 삭제하기 전에",
    accountDeletionImpactCurrentClient:
      "이 기기는 즉시 로그아웃됩니다. 다른 클라이언트는 로그인 상태가 무효화된 후 로그아웃됩니다.",
    accountDeletionImpactGrace:
      "계정은 30일 대기 기간에 들어갑니다. 이 기간에 다시 로그인하면 삭제가 취소됩니다.",
    accountDeletionImpactPermanent:
      "대기 기간이 끝나면 Cindy 로그인 계정은 영구적으로 삭제됩니다.",
    accountDeletionAppleNotice:
      "Apple로 로그인을 사용하는 경우 Apple ID 설정에서 Cindy 사용 중지를 직접 해야 할 수 있습니다.",
    accountDeletionCodeWillSend: "인증 코드를 {target}(으)로 보냅니다.",
    accountDeletionSendingCode: "보내는 중",
    accountDeletionErrorChallenge:
      "인증 코드가 올바르지 않거나 만료되었습니다. 확인 후 다시 시도해 주세요.",
    accountDeletionErrorAttempts:
      "인증 시도가 너무 많습니다. 인증 코드를 다시 보내주세요.",
    accountDeletionErrorRate:
      "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
    accountDeletionErrorPending: "계정이 이미 삭제 대기 기간에 들어갔습니다.",
    accountDeletionErrorProcessing: "계정 삭제가 이미 진행 중입니다.",
    accountDeletionErrorUnavailable: "현재 이 작업을 사용할 수 없습니다.",
    accountDeletionErrorNetwork:
      "네트워크 연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.",
    accountDeletionErrorFallback:
      "작업이 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.",
    accountDeletionRestoredTitle: "계정이 복구되었습니다",
    accountDeletionRestoredCopy:
      "이번 로그인으로 계정 삭제가 취소되었습니다. Cindy 로그인 계정은 계속 유지됩니다.",
    errorFallback: "로그인이 완료되지 않았습니다. 다시 시도해 주세요.",
    endpointGateTitle: "서버 설정을 가져올 수 없습니다",
    endpointGateSubtitle:
      "네트워크 연결을 확인한 후 다시 시도해 주세요({reason})",
    retry: "다시 시도",
    configIssueAuthBaseUrl: "로그인 서비스 주소는 http(s) URL이어야 합니다.",
  },
} as const;

export type LoginMessageKey = keyof (typeof messages)["zh-CN"];

// 编译期 parity 闸:任一 locale 缺 key 在此行报 typecheck 错;多余 key 由
// loginMessages.test.ts 的 key 全集一致断言 + parity 脚本双向兜底。
export const loginMessages: Record<
  LoginLocale,
  Record<LoginMessageKey, string>
> = messages;

/**
 * 纯函数:BCP 47 languageTag → 登录 locale。
 * 中文按脚本/区域选择 zh-TW 或 zh-CN；zh-TW 仅影响客户端文案，不改变 auth wire locale;
 * ja / ko 前缀直取;其余兜底 en。大小写不敏感。
 */
export function resolveLoginLocale(
  languageTag: string | null | undefined,
): LoginLocale {
  const tag = languageTag?.toLowerCase() ?? "";
  if (tag.startsWith("zh")) {
    if (tag.includes("hans")) return "zh-CN";
    if (tag.includes("hant") || /(?:-|^)(?:tw|hk|mo)(?:-|$)/.test(tag))
      return "zh-TW";
    return "zh-CN";
  }
  if (tag.startsWith("ja")) return "ja";
  if (tag.startsWith("ko")) return "ko";
  return "en";
}

/** 生效语言:设置里的手动选择优先,未选择时跟随系统语言。 */
export function getLoginLanguage(): LoginLocale {
  return (
    getManualLocaleOverride() ??
    resolveLoginLocale(getLocales()[0]?.languageTag)
  );
}

/**
 * 透传给 auth server 的 ui locale。**钳制在旧值域 zh-CN | en**(与既有 catalog
 * 的 wire 行为逐字节一致):server 侧 ui_locale 对 ja/ko 的容忍度未验证,
 * 本支边界=只动文案层,不改发往服务端的取值〔lead 裁决 2026-07-20:钳制即本
 * 批次终态,放开为独立后续项已由 lead 登记跟踪〕。
 */
export function getAuthLocale(): "zh-CN" | "en" {
  const locale = getLoginLanguage();
  return locale === "zh-CN" || locale === "zh-TW" ? "zh-CN" : "en";
}

export function loginText(key: LoginMessageKey): string {
  return loginMessages[getLoginLanguage()][key];
}

/** 登录错误码 → 多语文案(与 catalog 同一 locale 解析;导出供 parity/闸门测试)。 */
export const authErrorMessages: Record<string, Record<LoginLocale, string>> = {
  INVALID_CODE: {
    "zh-CN": "验证码无效或已过期。",
    "zh-TW": "驗證碼無效或已過期。",
    en: "The verification code is invalid or expired.",
    ja: "認証コードが無効か、有効期限が切れています。",
    ko: "인증 코드가 유효하지 않거나 만료되었습니다.",
  },
  INVALID_PARAMS: {
    "zh-CN": "输入内容格式不正确。",
    "zh-TW": "輸入內容格式不正確。",
    en: "Please check the information you entered.",
    ja: "入力内容の形式が正しくありません。",
    ko: "입력한 내용의 형식이 올바르지 않습니다.",
  },
  INVALID_AUTH_CODE: {
    "zh-CN": "登录授权已过期，请重新发起。",
    "zh-TW": "登入授權已過期，請重新發起。",
    en: "The authorization expired. Please start again.",
    ja: "ログインの認可の有効期限が切れました。もう一度やり直してください。",
    ko: "로그인 인증이 만료되었습니다. 다시 시도해 주세요.",
  },
  INVALID_LOGIN_TICKET: {
    "zh-CN": "身份选择已过期，请重新登录。",
    "zh-TW": "身分選擇已過期，請重新登入。",
    en: "Account selection expired. Please sign in again.",
    ja: "アカウント選択の有効期限が切れました。再度ログインしてください。",
    ko: "계정 선택이 만료되었습니다. 다시 로그인해 주세요.",
  },
  INVALID_BIND_TICKET: {
    "zh-CN": "绑定流程已过期，请重新登录。",
    "zh-TW": "綁定流程已過期，請重新登入。",
    en: "Verification expired. Please sign in again.",
    ja: "認証手続きの有効期限が切れました。再度ログインしてください。",
    ko: "인증 절차가 만료되었습니다. 다시 로그인해 주세요.",
  },
  STATE_MISMATCH: {
    "zh-CN": "登录状态校验失败，请重新登录。",
    "zh-TW": "登入狀態校驗失敗，請重新登入。",
    en: "Sign-in state validation failed. Please try again.",
    ja: "ログイン状態の検証に失敗しました。もう一度お試しください。",
    ko: "로그인 상태 검증에 실패했습니다. 다시 시도해 주세요.",
  },
  REGION_MISMATCH: {
    "zh-CN": "客户端区域与登录服务不匹配。",
    "zh-TW": "客戶端區域與登入服務不匹配。",
    en: "This app does not match the authentication region.",
    ja: "このアプリはログインサービスのリージョンと一致しません。",
    ko: "이 앱은 로그인 서비스 지역과 일치하지 않습니다.",
  },
  NETWORK_ERROR: {
    "zh-CN": "网络连接失败，请检查网络后重试。",
    "zh-TW": "網路連線失敗，請檢查網路後重試。",
    en: "Could not connect. Check your network and try again.",
    ja: "ネットワークに接続できません。接続を確認してから再試行してください。",
    ko: "네트워크에 연결할 수 없습니다. 네트워크를 확인한 후 다시 시도해 주세요.",
  },
  REQUEST_TIMEOUT: {
    "zh-CN": "登录请求超时，请重试。",
    "zh-TW": "登入請求超時，請重試。",
    en: "The sign-in request timed out. Please try again.",
    ja: "ログイン要求がタイムアウトしました。もう一度お試しください。",
    ko: "로그인 요청 시간이 초과되었습니다. 다시 시도해 주세요.",
  },
  USER_CANCELLED: {
    "zh-CN": "已取消登录。",
    "zh-TW": "已取消登入。",
    en: "Sign-in was cancelled.",
    ja: "ログインをキャンセルしました。",
    ko: "로그인이 취소되었습니다.",
  },
  SOCIAL_PROVIDER_NOT_CONFIGURED: {
    "zh-CN": "该登录方式尚未完成配置。",
    "zh-TW": "該登入方式尚未完成設定。",
    en: "This sign-in method is not configured yet.",
    ja: "このログイン方法はまだ設定されていません。",
    ko: "이 로그인 방법은 아직 설정되지 않았습니다.",
  },
  SOCIAL_PROVIDER_UNAVAILABLE: {
    "zh-CN": "当前设备无法使用该登录方式。",
    "zh-TW": "當前裝置無法使用該登入方式。",
    en: "This sign-in method is unavailable on this device.",
    ja: "このデバイスではこのログイン方法を利用できません。",
    ko: "이 기기에서는 이 로그인 방법을 사용할 수 없습니다.",
  },
  AUTH_REQUEST_FAILED: {
    "zh-CN": "登录服务暂时不可用，请稍后重试。",
    "zh-TW": "登入服務暫時不可用，請稍後重試。",
    en: "The sign-in service is temporarily unavailable.",
    ja: "ログインサービスは一時的に利用できません。しばらくしてからお試しください。",
    ko: "로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  },
  ACCOUNT_UNAVAILABLE: {
    "zh-CN": "当前账号不可用，已退出登录。",
    "zh-TW": "目前帳號不可用，已登出。",
    en: "This account is unavailable. You have been signed out.",
    ja: "このアカウントは利用できません。ログアウトしました。",
    ko: "이 계정을 사용할 수 없습니다. 로그아웃되었습니다.",
  },
  ORG_SSO_NOT_FOUND: {
    "zh-CN": "未找到该企业，或该企业未启用 SSO 登录。",
    "zh-TW": "未找到該企業，或該企業未啟用 SSO 登入。",
    en: "Company not found, or it has no SSO connection enabled.",
    ja: "会社が見つからないか、SSO ログインが有効になっていません。",
    ko: "회사를 찾을 수 없거나 SSO 로그인이 활성화되어 있지 않습니다.",
  },
  ORG_REALM_AMBIGUOUS: {
    "zh-CN": "该企业标识同时存在于两个区域，请联系企业管理员处理。",
    "zh-TW": "該企業標識同時存在於兩個區域，請聯絡企業管理員處理。",
    en: "This enterprise identifier exists in both regions. Contact your administrator.",
    ja: "この企業識別子は両方の地域に存在します。管理者にお問い合わせください。",
    ko: "이 기업 식별자가 두 지역에 모두 존재합니다. 관리자에게 문의하세요.",
  },
  ORG_REALM_UNAVAILABLE: {
    "zh-CN": "暂时无法确认企业所在区域，请检查网络后重试。",
    "zh-TW": "暫時無法確認企業所在區域，請檢查網路後重試。",
    en: "Cindy cannot verify the enterprise region right now. Check your connection and retry.",
    ja: "企業の地域を現在確認できません。ネットワークを確認して再試行してください。",
    ko: "현재 기업 지역을 확인할 수 없습니다. 네트워크를 확인한 후 다시 시도하세요.",
  },
  SSO_EMAIL_REQUIRED: {
    "zh-CN": "该企业身份未提供有效邮箱，请联系企业管理员检查 IdP 配置。",
    "zh-TW": "該企業身分未提供有效電子郵件，請聯絡企業管理員檢查 IdP 設定。",
    en: "Your work identity did not provide a valid email. Ask your admin to check the IdP configuration.",
    ja: "企業 ID に有効なメールアドレスが提供されていません。管理者に IdP 設定の確認をご依頼ください。",
    ko: "기업 신원에 유효한 이메일이 제공되지 않았습니다. 관리자에게 IdP 설정 확인을 요청하세요.",
  },
  INVALID_SSO_VERIFICATION_TICKET: {
    "zh-CN": "企业身份验证已过期，请重新发起 SSO 登录。",
    "zh-TW": "企業身分驗證已過期，請重新發起 SSO 登入。",
    en: "Work identity verification expired. Start SSO sign-in again.",
    ja: "企業 ID の確認期限が切れました。再度 SSO ログインを開始してください。",
    ko: "기업 신원 확인이 만료되었습니다. SSO 로그인을 다시 시작하세요.",
  },
};

export function authErrorText(code: string | null): string | null {
  if (!code) return null;
  const localized = authErrorMessages[code];
  return localized?.[getLoginLanguage()] ?? loginText("errorFallback");
}
