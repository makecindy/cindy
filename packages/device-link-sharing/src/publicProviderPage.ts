import { invitationCss } from './publicTaskPage.js';

/**
 * Public provider-share link handoff. The link token stays in the fragment and is
 * never sent to this route; the page reads no data and grants nothing. Requesting
 * a share happens only in the Cindy desktop app (always launched via cindy://), so
 * phones get a copy-link prompt instead of an app launch.
 */
export const providerShareInvitationHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>Cindy · Provider share</title><link rel="stylesheet" href="./join.css"><script src="./join.js" defer></script></head>
<body><main><img class="brand" src="./mark.png" width="48" height="48" alt="Cindy"><h1 id="title">Opening Cindy</h1>
<p id="intro">Continue in Cindy on your computer to review this provider share.</p>
<div id="actions" hidden><a id="open">Open Cindy</a>
<p id="fallback"><span id="fallbackBefore"></span> <button id="copy" type="button">Copy link</button></p>
<p id="status" role="status" aria-live="polite"></p>
<p class="download"><a id="download" href="https://cindy.app" rel="noreferrer">Download Cindy</a></p></div>
<noscript>Enable JavaScript to open this link in Cindy.</noscript></main></body></html>`;

/** Same tokens as the shared-task page, plus the mobile primary copy action. */
export const providerShareInvitationCss = `${invitationCss}
#actions #copy.primary{display:table;margin:28px auto 18px;min-width:174px;padding:12px 24px;border-radius:9999px;background:var(--cta);color:var(--cta-text);font-size:16px;font-weight:500;text-decoration:none;justify-content:center}`;

// Standalone script so CSP needs neither unsafe-inline nor eval; tsup bundles it.
export const providerShareInvitationScript = String.raw`(() => {
  'use strict';
  const copy = {
    'en': ['Opening Cindy','Continue in Cindy on this computer to review the provider share.','Open Cindy','Copy link','Download Cindy','This share link is invalid. Ask the sharer for a new link.','Link unavailable','Link copied. In Cindy, go to Settings → Providers → Providers Shared with Me and paste the link.','Copy failed. Copy the link from your browser address bar.','Open this link on your computer','Provider shares can only be requested and used in Cindy on a computer. Copy the link and open it there.','Link copied. Open it in a browser on your computer.','Didn’t open?','Review the provider share in Cindy','If Cindy didn’t open, copy the link and paste it in Cindy at Settings → Providers → Providers Shared with Me. Share links expire 5 minutes after they are created.'],
    'zh-CN': ['正在打开 Cindy','在这台电脑上的 Cindy 中继续，查看这个供应商分享。','打开 Cindy','复制链接','下载 Cindy','分享链接无效，请向分享者获取新的链接。','链接无效','链接已复制。前往 Cindy → 设置 → 模型供应商 →「分享给我的供应商」，粘贴链接即可。','复制失败，请从浏览器地址栏复制链接。','请在电脑上打开这个链接','供应商分享只能在电脑上的 Cindy 中申请和使用。请复制链接，在电脑上打开。','链接已复制。请在电脑的浏览器中打开。','没有打开？','在 Cindy 中查看供应商分享','如果 Cindy 没有打开，请复制链接，粘贴到 Cindy → 设置 → 模型供应商 →「分享给我的供应商」。分享链接生成后 5 分钟内有效。'],
    'zh-TW': ['正在開啟 Cindy','在這台電腦上的 Cindy 中繼續，查看這個供應商分享。','開啟 Cindy','複製連結','下載 Cindy','分享連結無效，請向分享者取得新的連結。','連結無效','連結已複製。前往 Cindy → 設定 → 模型供應商 →「分享給我的供應商」，貼上連結即可。','複製失敗，請從瀏覽器網址列複製連結。','請在電腦上開啟這個連結','供應商分享只能在電腦上的 Cindy 中申請和使用。請複製連結，在電腦上開啟。','連結已複製。請在電腦的瀏覽器中開啟。','沒有開啟？','在 Cindy 中查看供應商分享','如果 Cindy 沒有開啟，請複製連結，貼到 Cindy → 設定 → 模型供應商 →「分享給我的供應商」。分享連結產生後 5 分鐘內有效。'],
    'ja': ['Cindy を開いています','このコンピューターの Cindy で、プロバイダーの共有を確認してください。','Cindy を開く','リンクをコピー','Cindy をダウンロード','共有リンクが無効です。共有者に新しいリンクを依頼してください。','リンクが無効です','リンクをコピーしました。Cindy → 設定 → プロバイダー →「共有されたプロバイダー」でリンクを貼り付けてください。','コピーできませんでした。ブラウザーのアドレスバーからリンクをコピーしてください。','このリンクはコンピューターで開いてください','プロバイダーの共有は、コンピューターの Cindy でのみ申請・利用できます。リンクをコピーしてコンピューターで開いてください。','リンクをコピーしました。コンピューターのブラウザーで開いてください。','開きませんでしたか？','Cindy でプロバイダーの共有を確認','Cindy が開かない場合は、リンクをコピーして Cindy → 設定 → プロバイダー →「共有されたプロバイダー」に貼り付けてください。共有リンクの有効期限は作成から 5 分です。'],
    'ko': ['Cindy를 여는 중','이 컴퓨터의 Cindy에서 제공자 공유를 확인하세요.','Cindy 열기','링크 복사','Cindy 다운로드','유효하지 않은 공유 링크입니다. 공유한 사람에게 새 링크를 요청하세요.','유효하지 않은 링크','링크를 복사했습니다. Cindy → 설정 → 제공자 → \'나에게 공유된 제공자\'에서 링크를 붙여넣으세요.','복사하지 못했습니다. 브라우저 주소창에서 링크를 복사하세요.','컴퓨터에서 이 링크를 여세요','제공자 공유는 컴퓨터의 Cindy에서만 요청하고 사용할 수 있습니다. 링크를 복사해 컴퓨터에서 여세요.','링크를 복사했습니다. 컴퓨터의 브라우저에서 여세요.','열리지 않나요?','Cindy에서 제공자 공유 확인','Cindy가 열리지 않으면 링크를 복사해 Cindy → 설정 → 제공자 → \'나에게 공유된 제공자\'에 붙여넣으세요. 공유 링크는 생성 후 5분 동안 유효합니다.']
  };
  const language = (navigator.language || 'en').toLowerCase();
  const locale = language.startsWith('zh') ? (/tw|hk|hant/.test(language) ? 'zh-TW' : 'zh-CN') : language.startsWith('ja') ? 'ja' : language.startsWith('ko') ? 'ko' : 'en';
  const text = copy[locale];
  const el = id => document.getElementById(id);
  document.documentElement.lang = locale;
  document.title = 'Cindy · ' + text[0];
  ['title', 'intro', 'open', 'copy', 'download'].forEach((id, index) => { el(id).textContent = text[index]; });
  const page = new URL(location.href);
  const [token, hint, extra] = page.hash.slice(1).split('?');
  const app = hint === undefined ? 'cindy' : /^app=(cindy|cindycn|cindydev)$/.exec(hint)?.[1];
  const suffix = '/provider-share/join';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !app || extra !== undefined || page.search || !page.pathname.endsWith(suffix) || (page.protocol !== 'https:' && !(page.protocol === 'http:' && loopback))) {
    el('title').textContent = text[6];
    el('intro').textContent = text[5];
    document.title = 'Cindy';
    return;
  }
  const server = page.origin + page.pathname.slice(0, -suffix.length);
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el('download').href = app === 'cindycn' ? 'https://cindy.com.cn' : 'https://cindy.app';
  el('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(server + suffix + page.hash);
      el('status').textContent = text[mobile ? 11 : 7];
    }
    catch { el('status').textContent = text[8]; }
  });
  if (mobile) {
    // Requests are desktop-only: never launch the phone app from this page.
    el('title').textContent = text[9];
    el('intro').textContent = text[10];
    document.title = 'Cindy · ' + text[9];
    el('open').hidden = true;
    el('copy').className = 'primary';
    el('actions').hidden = false;
    return;
  }
  el('fallbackBefore').textContent = text[12];
  // Every desktop build (all regions and dev) registers cindy://; the app hint only picks
  // the download page here. It can never supply a scheme or redirect URL.
  el('open').href = 'cindy://provider-share/join?invitation=' + encodeURIComponent(token) + '&server=' + encodeURIComponent(server);
  el('actions').hidden = false;
  // Browsers may require a gesture for custom protocols. The visible link always remains available.
  try { location.href = el('open').href; } catch { /* The user can retry with the button. */ }
  // A remaining page is not proof of failure. Offer a neutral next step without claiming success.
  setTimeout(() => {
    el('title').textContent = text[13];
    el('intro').textContent = text[14];
    document.title = 'Cindy · ' + text[13];
  }, 1500);
})();`;
