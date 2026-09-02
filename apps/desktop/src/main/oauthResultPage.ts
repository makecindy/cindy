/**
 * Unified standalone OAuth callback/result page used by Desktop-owned browser
 * flows. These pages run in the system browser, so renderer theme tokens are
 * unavailable; the inlined values mirror docs/design-rules/cindy-design-system.md's default light/dark theme.
 */

import { DEEP_LINK_URL_PREFIX } from '../shared/deepLinkSchemes';
import { LOGIN_CALLBACK_CHIBI } from './assets/loginCallbackAssets';

export type OAuthResultPageLang = 'zh' | 'zh-TW' | 'en' | 'ja' | 'ko';
export type OAuthResultPageVariant = 'success' | 'warning' | 'error';
export type OAuthResultPageTheme = 'light' | 'dark';

/** 业务来源(三层 adapter 之一,PR3)。目前仅 desktop-login 切换到 wave4 新品牌卡。 */
export type OAuthResultPageKind =
  'desktop-login' | 'ghost-oauth' | 'claude-oauth' | 'xai-oauth' | 'generic-oauth';

/** 视觉三分类(三层 adapter 之三,callback-pages-classification.md 页壳改造点 1)。 */
export type OAuthResultVisualKind = 'success' | 'failure' | 'neutral';

/** 旧 variant → 视觉三分类的默认映射(error→failure / warning→neutral)。 */
const VARIANT_TO_VISUAL: Record<OAuthResultPageVariant, OAuthResultVisualKind> = {
  success: 'success',
  error: 'failure',
  warning: 'neutral',
};

export interface OAuthResultPageInput {
  /** BCP 47 tag for the html lang attribute. */
  htmlLang: string;
  variant: OAuthResultPageVariant;
  title: string;
  body: string;
  /** Raw diagnostic text rendered as escaped monospace detail. */
  detail?: string;
  /** Success-only countdown template; must contain a `{{count}}` placeholder. */
  closeCountdown?: string;
  /** Optional CTA, normally a cindy://focus/... link back to the app. */
  action?: { href: string; label: string };
  /** Preview-only override. Production omits it and follows the OS setting. */
  theme?: OAuthResultPageTheme;
  /**
   * 三层 adapter(PR3,全部 optional——旧调用不传即 legacy 页壳,ghost/claude/
   * xai/generic 视觉零变化):
   * - pageKind:业务来源;'desktop-login' → wave4 新品牌卡(成功 560×500、失败/警告 680×680,
   *   chibi 立绘 + U-10 跨视口缩放),其余值与缺省 = legacy 页壳。
   * - copyKind:文案族标签,不参与渲染分支,仅输出为 data-cindy-oauth-copy
   *   供测试与验收矩阵定位文案来源。
   * - visualKind:视觉三分类,缺省由 variant 映射(见 VARIANT_TO_VISUAL)。
   */
  pageKind?: OAuthResultPageKind;
  copyKind?: string;
  visualKind?: OAuthResultVisualKind;
}

export const OAUTH_RESULT_HTML_LANG: Record<OAuthResultPageLang, string> = {
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
};

/** Selects the first supported language in browser preference order. */
export function pickOAuthResultPageLang(acceptLanguage: string | undefined): OAuthResultPageLang {
  if (typeof acceptLanguage !== 'string' || acceptLanguage.length === 0) return 'en';
  for (const part of acceptLanguage.split(',')) {
    const primary = part.trim().split(';')[0]?.trim().toLowerCase() ?? '';
    if (primary.startsWith('zh')) {
      if (primary.includes('hans')) return 'zh';
      if (primary.includes('hant') || /(?:-|^)(?:tw|hk|mo)(?:-|$)/.test(primary)) {
        return 'zh-TW';
      }
      return 'zh';
    }
    if (primary.startsWith('ja')) return 'ja';
    if (primary.startsWith('ko')) return 'ko';
    if (primary.startsWith('en')) return 'en';
  }
  return 'en';
}

function returnLabel(lang: OAuthResultPageLang, brandName: string): string {
  switch (lang) {
    case 'zh':
      return `返回 ${brandName}`;
    case 'zh-TW':
      return `返回 ${brandName}`;
    case 'en':
      return `Return to ${brandName}`;
    case 'ja':
      return `${brandName} に戻る`;
    case 'ko':
      return `${brandName}(으)로 돌아가기`;
  }
}

/** Builds the stable app-focus CTA shared by browser callback pages. */
export function buildOAuthReturnAction(
  lang: OAuthResultPageLang,
  source: string,
  brandName: string,
): { href: string; label: string } {
  return {
    href: `${DEEP_LINK_URL_PREFIX}focus/${encodeURIComponent(source)}`,
    label: returnLabel(lang, brandName),
  };
}

interface ProviderOAuthCopy {
  successTitle: string;
  successBody: string;
  errorTitle: string;
  missingCodeBody: string;
  invalidStateBody: string;
  exchangeFailedBody: string;
}

/** Localized copy shared by xAI and descriptor-driven model providers. */
export function getProviderOAuthResultCopy(
  lang: OAuthResultPageLang,
  providerName: string,
  brandName: string,
): ProviderOAuthCopy {
  switch (lang) {
    case 'zh':
      return {
        successTitle: '授权成功',
        successBody: `${providerName} 已连接到 ${brandName}。你可以返回应用继续。`,
        errorTitle: '授权未完成',
        missingCodeBody: `没有收到 ${providerName} 的授权码，请返回 ${brandName} 重试。`,
        invalidStateBody: `授权校验失败，请返回 ${brandName} 重新发起连接。`,
        exchangeFailedBody: `连接 ${providerName} 时发生错误，请返回 ${brandName} 重试。`,
      };
    case 'zh-TW':
      return {
        successTitle: '授權成功',
        successBody: `${providerName} 已連線至 ${brandName}。你可以返回應用程式繼續。`,
        errorTitle: '授權未完成',
        missingCodeBody: `沒有收到 ${providerName} 的授權碼，請返回 ${brandName} 重試。`,
        invalidStateBody: `授權驗證失敗，請返回 ${brandName} 重新發起連線。`,
        exchangeFailedBody: `連線 ${providerName} 時發生錯誤，請返回 ${brandName} 重試。`,
      };
    case 'ja':
      return {
        successTitle: '認可が完了しました',
        successBody: `${providerName} が ${brandName} に接続されました。アプリに戻って続行できます。`,
        errorTitle: '認可を完了できませんでした',
        missingCodeBody: `${providerName} から認可コードを受信できませんでした。${brandName} に戻って再試行してください。`,
        invalidStateBody: `認可の検証に失敗しました。${brandName} に戻って接続をやり直してください。`,
        exchangeFailedBody: `${providerName} への接続中にエラーが発生しました。${brandName} に戻って再試行してください。`,
      };
    case 'ko':
      return {
        successTitle: '인증 완료',
        successBody: `${providerName} 계정이 ${brandName}에 연결되었습니다. 앱으로 돌아가 계속할 수 있습니다.`,
        errorTitle: '인증이 완료되지 않았습니다',
        missingCodeBody: `${providerName} 인증 코드를 받지 못했습니다. ${brandName}(으)로 돌아가 다시 시도하세요.`,
        invalidStateBody: `인증 검증에 실패했습니다. ${brandName}(으)로 돌아가 연결을 다시 시작하세요.`,
        exchangeFailedBody: `${providerName} 연결 중 오류가 발생했습니다. ${brandName}(으)로 돌아가 다시 시도하세요.`,
      };
    default:
      return {
        successTitle: 'Authorization complete',
        successBody: `${providerName} is now connected to ${brandName}. You can return to the app to continue.`,
        errorTitle: 'Authorization not completed',
        missingCodeBody: `No authorization code was received from ${providerName}. Return to ${brandName} and try again.`,
        invalidStateBody: `Authorization validation failed. Return to ${brandName} and start the connection again.`,
        exchangeFailedBody: `Something went wrong while connecting ${providerName}. Return to ${brandName} and try again.`,
      };
  }
}

/** 失败页文案键(免把中文散文当参数传, i18n 后统一走键)。 */
export type GhostOAuthErrorKind = 'provider-error' | 'invalid-callback' | 'internal';

interface GhostOAuthResultCopy {
  successTitle: string;
  /** {brand} 占位替换品牌名。 */
  successBody: string;
  errorTitle: string;
  /** {brand} / {detail} 占位由调用方替换(函数形式,防 $ 特殊模式展开)。 */
  errors: Record<GhostOAuthErrorKind, string>;
}

/**
 * Ghost(意识)OAuth 回调页文案。生产(cindy-brain/ghostOauthFlow)与 preview
 * 脚本共用这一份表——callback copy builder 生产/preview 合一(PR0b-callback),
 * 防止两处各维护一份翻译产生漂移。
 */
const GHOST_OAUTH_PAGE_STRINGS: Record<OAuthResultPageLang, GhostOAuthResultCopy> = {
  zh: {
    successTitle: '授权成功',
    successBody: '你可以关闭此页面，回到 {brand} 继续。',
    errorTitle: '授权失败',
    errors: {
      'provider-error': '授权服务器返回错误：{detail}',
      'invalid-callback': '回调参数不完整或校验失败，请回到 {brand} 重试。',
      internal: '回调处理异常，请回到 {brand} 重试。',
    },
  },
  'zh-TW': {
    successTitle: '授權成功',
    successBody: '你可以關閉此頁面，返回 {brand} 繼續。',
    errorTitle: '授權失敗',
    errors: {
      'provider-error': '授權伺服器傳回錯誤：{detail}',
      'invalid-callback': '回呼參數不完整或驗證失敗，請返回 {brand} 重試。',
      internal: '處理回呼時發生錯誤，請返回 {brand} 重試。',
    },
  },
  en: {
    successTitle: 'Authorization successful',
    successBody: 'You can close this page and return to {brand}.',
    errorTitle: 'Authorization failed',
    errors: {
      'provider-error': 'The authorization server returned an error: {detail}',
      'invalid-callback':
        'The callback is incomplete or failed validation. Please return to {brand} and try again.',
      internal:
        'Something went wrong while handling the callback. Please return to {brand} and try again.',
    },
  },
  ja: {
    successTitle: '認可が完了しました',
    successBody: 'このページを閉じて {brand} に戻れます。',
    errorTitle: '認可に失敗しました',
    errors: {
      'provider-error': '認可サーバーがエラーを返しました：{detail}',
      'invalid-callback':
        'コールバックのパラメータが不完全か検証に失敗しました。{brand} に戻ってやり直してください。',
      internal: 'コールバック処理中にエラーが発生しました。{brand} に戻ってやり直してください。',
    },
  },
  ko: {
    successTitle: '인증 완료',
    successBody: '이 페이지를 닫고 {brand}(으)로 돌아가세요.',
    errorTitle: '인증 실패',
    errors: {
      'provider-error': '인증 서버가 오류를 반환했습니다: {detail}',
      'invalid-callback':
        '콜백 매개변수가 불완전하거나 검증에 실패했습니다. {brand}(으)로 돌아가 다시 시도하세요.',
      internal: '콜백 처리 중 오류가 발생했습니다. {brand}(으)로 돌아가 다시 시도하세요.',
    },
  },
};

/** Ghost OAuth 回调页文案(占位符原样返回,替换责任在调用方)。 */
export function getGhostOAuthResultCopy(lang: OAuthResultPageLang): GhostOAuthResultCopy {
  return GHOST_OAUTH_PAGE_STRINGS[lang];
}

interface OAuthNeutralResultCopy {
  title: string;
  body: string;
}

/**
 * 回调「中性/需要继续操作」态文案(demo CALLBACK.neutral verbatim 源,PR0b-callback
 * 所有支持语言一次补齐)。
 * 当前生产端暂无中性态调用方(见 callback-pages-classification.md),preview 的
 * warning 页与未来的 Ghost 安装/Slack hook 等「需回 app 继续」场景共用此表。
 */
export function getOAuthNeutralResultCopy(
  lang: OAuthResultPageLang,
  brandName: string,
): OAuthNeutralResultCopy {
  switch (lang) {
    case 'zh':
      return {
        title: '需要继续操作',
        body: `请返回 ${brandName}，完成当前工作区的安装后继续。`,
      };
    case 'zh-TW':
      return {
        title: '需要繼續操作',
        body: `請返回 ${brandName}，完成目前工作區的安裝後繼續。`,
      };
    case 'ja':
      return {
        title: '操作が必要です',
        body: `${brandName} に戻り、現在のワークスペースへのインストールを完了してください。`,
      };
    case 'ko':
      return {
        title: '추가 작업 필요',
        body: `${brandName}로 돌아가 현재 워크스페이스 설치를 완료하세요.`,
      };
    default:
      return {
        title: 'Action required',
        body: `Return to ${brandName} and finish installing in the current workspace.`,
      };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Static monochrome Lucide paths; icons never animate. */
const RESULT_ICON: Record<OAuthResultPageVariant, string> = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<path d="M18 6 6 18M6 6l12 12"/>',
  warning:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

/**
 * 结果页内联布局脚本(U-10:整卡等比缩放 + 水平居中),并在登录成功页尝试
 * 自动关闭当前浏览器页面。成功卡和失败卡的尺寸由页面标记提供,这样成功态
 * 可以在移除 CTA 后收紧卡片而不改变失败态的既有几何。
 *
 * 抽成导出常量而不是直接内联在模板串里,是为了让**需要它 CSP sha256 的一方直接对
 * 这段源文本取值**——托管回调把结果页搬到 auth-server 后,导出脚本要为每页算
 * `script-src 'sha256-…'`。从渲染完成的 HTML 里反向抠这段,既依赖 HTML 解析细节,
 * 也会被 CodeQL 当成「对渲染结果做哈希」误报。直接引用常量则两端拿到同一份逐字节
 * 内容。
 *
 * `window.close()` 受浏览器的 script-closable 限制,失败时无副作用,正文仍告知用户
 * 手动关闭页面。改动这里等于改动 CSP hash,必须重新导出模板并同步到 auth-server。
 */
export const LOGIN_CALLBACK_LAYOUT_SCRIPT = `
/* U-10:整卡等比缩放,transform-origin=top center 语义经「缩放尺寸 wrapper +
   margin auto」实现水平居中;stage 布局尺寸取页面标记,缩到仍放不下时溢出走
   body 纵向滚动,不裁内容。 */
(function(){
var card=document.getElementById('card'),stage=document.getElementById('stage'),countdown=document.getElementById('close-countdown');
var cardWidth=Number(stage.dataset.cardWidth)||680,cardHeight=Number(stage.dataset.cardHeight)||680;
function fit(){
var w=window.innerWidth,h=window.innerHeight;
var topOffset=w<760?88:80;
var scale=Math.min(1,(w-32)/cardWidth,(h-topOffset-24)/cardHeight);
card.style.transform='scale('+scale+')';
stage.style.width=(cardWidth*scale)+'px';
stage.style.height=(cardHeight*scale)+'px';
stage.style.marginTop=topOffset+'px';
}
window.addEventListener('resize',fit);
fit();
if(document.body.dataset.cindyOauthResult==='success'&&countdown){
var remaining=3,timer;
var template=countdown.dataset.template||'';
function updateCountdown(){countdown.textContent=template.replace('{{count}}',String(remaining));}
function attemptClose(){
window.clearInterval(timer);
countdown.remove();
try{window.close();}catch(_){/* Browser may reject closing this tab. */}
}
updateCountdown();
timer=window.setInterval(function(){
remaining-=1;
if(remaining<=0){attemptClose();return;}
updateCountdown();
},1000);
}
})();
`;

/**
 * wave4 新品牌回调卡(仅 pageKind='desktop-login',PR3)。
 *
 * 参数权威:callback-pages-classification.md「新设计三类卡片规格」(figma §6.1,
 * 失败/警告卡 680×680 r36;成功卡在移除 CTA 后采用 560×500 紧凑流式布局,
 * 这是 2026-09-02 登录成功回调 UX 裁决对旧成功态 Figma 帧的覆盖。
 * White 卡 #FBFBFB/#D4D4D4、Dark 卡 #312F2F/#434343;页面底色浅 #EEEEEE/深
 * #2A2828,design.md §7.4 条 1)+ U-10 裁决(topOffset = w<760?88:80;scale 按
 * 页面标记的卡片尺寸计算,transform-origin=top center,水平居中,缩不下时纵向
 * 滚动不裁内容)。色值按 token-decision-table 决策以可序列化常量内联(系统
 * 浏览器页拿不到 renderer token,表内「browser callback main 使用同一份可
 * 序列化常量」)。hover 仅 hover-capable 设备生效(触摸浏览器无 hover 差异)。
 * detail 按 U-2 = 现网行为:错误码单行(nowrap + ellipsis),仍走 escapeHtml。
 * chibi 立绘为构建期 data URI(U-7):占位盒固定 280×280,加载失败仅隐藏图片,
 * 文字与 CTA 不受影响(onerror 降级,adaptation §5 条 8 方向)。
 */
function renderBrandLoginCallbackPage(
  input: OAuthResultPageInput,
  visual: OAuthResultVisualKind,
): string {
  const isSuccess = input.variant === 'success';
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : '';
  const action =
    input.variant === 'success'
      ? ''
      : input.action
        ? `<a class="cta" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`
        : '';
  const themeAttr = input.theme ? ` data-theme="${input.theme}"` : '';
  const copyAttr = input.copyKind ? ` data-cindy-oauth-copy="${escapeHtml(input.copyKind)}"` : '';
  const layoutAttr = isSuccess ? ' data-cindy-oauth-layout="compact"' : '';
  const cardWidth = isSuccess ? 560 : 680;
  const cardHeight = isSuccess ? 500 : 680;
  const cardClass = isSuccess ? 'card success' : 'card';
  const initialCountdown = input.closeCountdown?.replaceAll('{{count}}', '3');
  const closeCountdown =
    isSuccess && input.closeCountdown
      ? `<p class="close-countdown" id="close-countdown" data-template="${escapeHtml(input.closeCountdown)}">${escapeHtml(initialCountdown ?? '')}</p>`
      : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.htmlLang)}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Cindy</title>
<style>
:root{color-scheme:light;--page:#eeeeee;--card:#fbfbfb;--card-border:#d4d4d4;--title:#252222;--body:#6f6f6f;--detail:#a3a3a3;--cta:#2a2828;--cta-border:#434343;--cta-text:#d4d4d4;--cta-hover:rgba(255,255,255,.08);--cta-active:rgba(0,0,0,.5)}
:root[data-theme="dark"]{color-scheme:dark;--page:#2a2828;--card:#312f2f;--card-border:#434343;--title:#d4d4d4;--body:#6f6f6f;--detail:#737373;--cta:#eeeeee;--cta-border:#ffffff;--cta-text:#2a2828;--cta-hover:rgba(0,0,0,.05);--cta-active:rgba(0,0,0,.1)}
@media(prefers-color-scheme:dark){:root:not([data-theme]){color-scheme:dark;--page:#2a2828;--card:#312f2f;--card-border:#434343;--title:#d4d4d4;--body:#6f6f6f;--detail:#737373;--cta:#eeeeee;--cta-border:#ffffff;--cta-text:#2a2828;--cta-hover:rgba(0,0,0,.05);--cta-active:rgba(0,0,0,.1)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--page);font-family:"HarmonyOS Sans SC",Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.stage{position:relative;margin:0 auto 24px}
.card{position:absolute;left:0;top:0;width:680px;height:680px;border-radius:36px;border:1px solid var(--card-border);background:var(--card);overflow:clip;transform-origin:top left}
.visual{position:absolute;left:200px;top:60px;width:280px;height:280px;object-fit:contain}
h1{position:absolute;left:42px;top:352px;width:598px;height:38px;margin:0;font-size:32px;line-height:38px;font-weight:700;color:var(--title);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{position:absolute;left:41px;top:396px;width:599px;height:23px;margin:0;font-size:20px;line-height:23px;font-weight:400;color:var(--body);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail{position:absolute;left:41px;top:434px;width:599px;margin:0;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;color:var(--detail);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cta{position:absolute;left:70px;top:529px;width:540px;height:80px;border-radius:40px;background:var(--cta);border:1px solid var(--cta-border);color:var(--cta-text);font-size:24px;font-weight:700;display:grid;place-items:center;text-decoration:none;overflow:hidden}
.cta::after{content:"";position:absolute;inset:0;border-radius:inherit;opacity:0;transition:opacity .15s ease}
@media(hover:hover){.cta:hover::after{opacity:1;background:var(--cta-hover)}}
.cta:active::after{opacity:1;background:var(--cta-active)}
.cta:focus-visible{outline:3px solid rgba(59,130,246,.5);outline-offset:3px}
.card.success{width:560px;height:500px;display:flex;flex-direction:column;align-items:center;padding:48px 40px 44px}
.card.success .visual{position:static;flex:0 0 240px;width:240px;height:240px}
.card.success .content{display:flex;flex-direction:column;align-items:center;width:100%;margin-top:24px;gap:10px}
.card.success h1{position:static;flex:0 0 auto;width:100%;height:auto;margin:0;font-size:32px;line-height:38px;white-space:normal;overflow:visible;text-overflow:clip}
.card.success .body{position:static;flex:0 0 auto;width:100%;max-width:480px;height:auto;min-height:28px;margin:0;font-size:20px;line-height:28px;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
.card.success .close-countdown{flex:0 0 auto;margin:auto 0 0;color:var(--detail);font-size:16px;line-height:23px;text-align:center;white-space:nowrap}
</style>
</head>
<body data-cindy-oauth-result="${input.variant}" data-cindy-oauth-visual="${visual}"${layoutAttr}${copyAttr}>
<div class="stage" id="stage" data-card-width="${cardWidth}" data-card-height="${cardHeight}">
<main class="${cardClass}" id="card">
<img class="visual" src="${LOGIN_CALLBACK_CHIBI[visual]}" alt="" onerror="this.style.visibility='hidden'">
<div class="content">
<h1>${title}</h1>
<p class="body">${body}</p>
${detail}
${action}
</div>
${closeCountdown}
</main>
</div>
<script>${LOGIN_CALLBACK_LAYOUT_SCRIPT}</script>
</body>
</html>`;
}

/** Renders the production callback page shell shared by every Desktop OAuth flow. */
export function renderOAuthResultPage(input: OAuthResultPageInput): string {
  // 三层 adapter 分发:desktop-login → 新品牌卡;其余(含缺省)= legacy 页壳,
  // 输出与 PR3 之前逐字节一致(ghost/claude/xai/generic 视觉零变化)。
  if (input.pageKind === 'desktop-login') {
    return renderBrandLoginCallbackPage(
      input,
      input.visualKind ?? VARIANT_TO_VISUAL[input.variant],
    );
  }
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : '';
  const action = input.action
    ? `<a class="cta" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>`
    : '';
  const themeAttr = input.theme ? ` data-theme="${input.theme}"` : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.htmlLang)}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Cindy</title>
<style>
:root{color-scheme:light;--page:#f8f8f6;--card:#fff;--border:#d7d7d4;--text:#262626;--muted:#737373;--detail:#a3a3a3;--chip:#e5e5e5;--cta:#000;--cta-text:#fff;--cta-hover:#262626}
:root[data-theme="dark"]{color-scheme:dark;--page:#1f1f1e;--card:#2c2c2a;--border:#3c3c3a;--text:#d4d4d4;--muted:#a3a3a3;--detail:#737373;--chip:#3c3c3a;--cta:#fff;--cta-text:#000;--cta-hover:#e5e5e5}
@media(prefers-color-scheme:dark){:root:not([data-theme]){color-scheme:dark;--page:#1f1f1e;--card:#2c2c2a;--border:#3c3c3a;--text:#d4d4d4;--muted:#a3a3a3;--detail:#737373;--chip:#3c3c3a;--cta:#fff;--cta-text:#000;--cta-hover:#e5e5e5}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--page);color:var(--text)}
.card{width:min(100%,400px);padding:40px 44px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:12px}
.badge{width:48px;height:48px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;border-radius:9999px;background:var(--chip);color:var(--text)}
h1{margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:500;color:var(--text)}
p{margin:0;font-size:14px;line-height:1.6;font-weight:400;color:var(--muted)}
.detail{margin-top:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:var(--detail);overflow-wrap:anywhere}
.cta{display:inline-flex;min-height:44px;margin-top:24px;padding:10px 24px;align-items:center;justify-content:center;border-radius:9999px;background:var(--cta);color:var(--cta-text);font-size:15px;line-height:1.4;font-weight:500;text-decoration:none;transition:background-color .15s ease}
.cta:hover{background:var(--cta-hover)}
.cta:focus-visible{outline:3px solid rgba(59,130,246,.5);outline-offset:3px}
@media(max-width:480px){.card{padding:32px 24px}.badge{margin-bottom:16px}h1{font-size:18px}}
</style>
</head>
<body data-cindy-oauth-result="${input.variant}">
<main class="card">
<span class="badge" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${RESULT_ICON[input.variant]}</svg></span>
<h1>${title}</h1>
<p>${body}</p>
${detail}
${action}
</main>
</body>
</html>`;
}
