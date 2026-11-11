
/** Public handoff only. The invitation stays in the fragment and is never sent to this route. */
export const invitationHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>Cindy · Shared task</title><link rel="stylesheet" href="./join.css"><script src="./join.js" defer></script></head>
<body><main><img class="brand" src="./mark.png" width="48" height="48" alt="Cindy"><h1 id="title">Opening Cindy</h1>
<p id="intro">Continue in the app to join this shared task.</p>
<div id="actions" hidden><a id="open">Open Cindy</a>
<p id="fallback"><span id="fallbackBefore"></span> <button id="copy" type="button">Copy link</button><br><span id="fallbackAfter"></span></p>
<p id="status" role="status" aria-live="polite"></p>
<details><summary id="helpTitle"></summary><p id="helpBody"></p></details>
<p class="download"><a id="download" href="https://cindy.app" rel="noreferrer">Download Cindy</a></p></div>
<noscript>Enable JavaScript to open this invitation in Cindy.</noscript></main></body></html>`;

export const invitationCss = `:root{color-scheme:light dark;--page:#f9f9f6;--text:#0f0f0f;--muted:#4d4d4a;--border:#ccccc8;--cta:#0f0f0f;--cta-text:#fff;--focus:#686864}
@media(prefers-color-scheme:dark){:root{--page:#121212;--text:#ededed;--muted:#bdbdbd;--border:#383838;--cta:#ededed;--cta-text:#121212;--focus:#999}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;background:var(--page);color:var(--text);font:15px/22px Inter,system-ui,-apple-system,sans-serif}main{max-width:520px;width:100%;padding:48px 24px 12vh;text-align:center}.brand{display:block;margin:0 auto 28px;border-radius:12px}h1{font-size:24px;line-height:30px;font-weight:600;margin:0 0 14px}p{color:var(--muted);margin:8px 0}a,button,summary{color:var(--text);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}button{border:0;background:transparent}#actions{font-size:13px;line-height:20px}#actions a,#actions button,summary{display:inline-flex;min-height:44px;align-items:center;padding:10px 4px}#actions #open{display:table;margin:28px auto 18px;min-width:174px;padding:12px 24px;border-radius:9999px;background:var(--cta);color:var(--cta-text);font-size:16px;font-weight:500;text-decoration:none}#actions[hidden],[hidden]{display:none!important}:focus-visible{outline:2px solid var(--focus);outline-offset:3px}#fallback,#status,details{max-width:330px;margin-left:auto;margin-right:auto}#status{overflow-wrap:anywhere;text-align:left;border-left:2px solid var(--text);padding-left:12px;margin-top:20px}#status:empty{display:none}details{margin-top:24px}summary{list-style:none}summary::-webkit-details-marker{display:none}details p{line-height:22px}.download{margin-top:16px}#download{color:var(--muted)}noscript{color:var(--muted)}`;

// Kept as a standalone script so CSP needs neither unsafe-inline nor eval, and tsup bundles the assets.
export const invitationScript = String.raw`(() => {
  'use strict';
  const copy = {
    "en": ["Opening Cindy","Continue in the app to join this shared task.","Open again","Copy link","Download Cindy","This invitation link is invalid. Ask the host for a new link.","Invitation unavailable","Invitation link copied","Copy failed. Copy the link from your browser address bar."],
    "zh-CN": ["正在打开 Cindy","在浏览器提示中打开应用，加入共享任务。","再次打开","复制邀请链接","下载 Cindy","邀请链接无效，请向房主获取新的链接。","邀请链接无效","邀请链接已复制","复制失败，请从浏览器地址栏复制链接。"],
    "zh-TW": ["正在開啟 Cindy","在瀏覽器提示中開啟應用程式，加入共享任務。","再次開啟","複製邀請連結","下載 Cindy","邀請連結無效，請向房主取得新的連結。","邀請連結無效","邀請連結已複製","複製失敗，請從瀏覽器網址列複製連結。"],
    "ja": ["Cindy を開いています","ブラウザーの案内に従ってアプリを開き、共有タスクに参加してください。","もう一度開く","リンクをコピー","Cindy をダウンロード","招待リンクが無効です。ホストに新しいリンクを依頼してください。","招待リンクが無効です","招待リンクをコピーしました","コピーできませんでした。ブラウザーのアドレスバーからリンクをコピーしてください。"],
    "ko": ["Cindy를 여는 중","브라우저 안내에 따라 앱을 열고 공유 작업에 참여하세요.","다시 열기","링크 복사","Cindy 다운로드","유효하지 않은 초대 링크입니다. 호스트에게 새 링크를 요청하세요.","유효하지 않은 초대 링크","초대 링크를 복사했습니다","복사하지 못했습니다. 브라우저 주소창에서 링크를 복사하세요."]
  };
  const language = (navigator.language || 'en').toLowerCase();
  const locale = language.startsWith('zh') ? (/tw|hk|hant/.test(language) ? 'zh-TW' : 'zh-CN') : language.startsWith('ja') ? 'ja' : language.startsWith('ko') ? 'ko' : 'en';
  const text = copy[locale];
  // Platform-specific next steps: only mobile automatically recognizes clipboard invitations.
  const guidance = {
    'en': ['Join a shared task in Cindy','Open the app to continue working with your teammate.','Didn’t open?', 'Then open Cindy and confirm to join.', 'Then paste it in Cindy to join manually.', 'Copied. Open Cindy to see the invitation and confirm to join.', 'Copied. Go to Cindy → Settings → Shared tasks → Join shared task and paste the link.', 'Still need help?', 'If no invitation appears, go to Cindy → Settings → Shared tasks → Join shared task and paste the link.', 'Go to Cindy → Settings → Shared tasks → Join shared task and paste the link.', 'Open Cindy'],
    'zh-CN': ['在 Cindy 中加入共享任务','打开 App，继续与伙伴一起完成任务。','没有打开？','再打开 Cindy，确认即可加入。','前往 Cindy，粘贴链接手动加入。','已复制。现在打开 Cindy，会提示你确认加入。','已复制。前往 Cindy → 设置 → 共享任务 → 加入共享任务，粘贴链接。','仍无法加入？','如果打开 App 后没有出现邀请提示，前往 Cindy → 设置 → 共享任务 → 共享管理 → 加入共享任务，粘贴链接。','前往 Cindy → 设置 → 共享任务 → 加入共享任务，粘贴链接。','打开 Cindy'],
    'zh-TW': ['在 Cindy 中加入共享任務','開啟 App，繼續與夥伴一起完成任務。','沒有開啟？','再開啟 Cindy，確認即可加入。','前往 Cindy，貼上連結手動加入。','已複製。現在開啟 Cindy，會提示你確認加入。','已複製。前往 Cindy → 設定 → 共享任務 → 加入共享任務，貼上連結。','仍無法加入？','若開啟 App 後沒有出現邀請提示，前往 Cindy → 設定 → 共享任務 → 共享管理 → 加入共享任務，貼上連結。','前往 Cindy → 設定 → 共享任務 → 加入共享任務，貼上連結。','開啟 Cindy'],
    'ja': ['Cindy で共有タスクに参加','アプリを開いて、パートナーとタスクを続けましょう。','開きませんでしたか？','Cindy を開き、参加を確認してください。','Cindy でリンクを貼り付けて参加してください。','コピーしました。Cindy を開くと招待が表示され、参加を確認できます。','コピーしました。Cindy → 設定 → 共有タスク → 共有タスクに参加でリンクを貼り付けてください。','参加できない場合','招待が表示されない場合は、Cindy → 設定 → 共有タスク → 共有管理 → 共有タスクに参加でリンクを貼り付けてください。','Cindy → 設定 → 共有タスク → 共有タスクに参加でリンクを貼り付けてください。','Cindy を開く'],
    'ko': ['Cindy에서 공유 작업 참여','앱을 열고 동료와 함께 작업을 이어가세요.','열리지 않나요?','Cindy를 열고 참여를 확인하세요.','Cindy에서 링크를 붙여넣어 직접 참여하세요.','복사했습니다. Cindy를 열면 초대가 표시되고 참여를 확인할 수 있습니다.','복사했습니다. Cindy → 설정 → 공유 작업 → 공유 작업 참여에서 링크를 붙여넣으세요.','아직 참여할 수 없나요?','초대가 표시되지 않으면 Cindy → 설정 → 공유 작업 → 공유 관리 → 공유 작업 참여에서 링크를 붙여넣으세요.','Cindy → 설정 → 공유 작업 → 공유 작업 참여에서 링크를 붙여넣으세요.','Cindy 열기']
  }[locale];
  const el = id => document.getElementById(id);
  document.documentElement.lang = locale;
  document.title = 'Cindy · ' + text[0];
  ['title', 'intro', 'open', 'copy', 'download'].forEach((id, index) => { el(id).textContent = text[index]; });
  const page = new URL(location.href);
  const [token, hint, extra] = page.hash.slice(1).split('?');
  const app = hint === undefined ? 'cindy' : /^app=(cindy|cindycn|cindydev)$/.exec(hint)?.[1];
  const suffix = '/shared-task/join';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !app || extra !== undefined || page.search || !page.pathname.endsWith(suffix) || (page.protocol !== 'https:' && !(page.protocol === 'http:' && loopback))) {
    el('title').textContent = text[6];
    el('intro').textContent = text[5];
    document.title = 'Cindy';
    return;
  }
  const server = page.origin + page.pathname.slice(0, -suffix.length);
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el('open').textContent = guidance[10];
  el('fallbackBefore').textContent = guidance[2];
  el('fallbackAfter').textContent = guidance[mobile ? 3 : 4];
  el('helpTitle').textContent = guidance[7];
  el('helpBody').textContent = guidance[mobile ? 8 : 9];
  // The originating build supplies a closed-set app hint. It cannot supply a redirect URL.
  const scheme = mobile ? app : 'cindy';
  el('open').href = scheme + (mobile ? '://shared-session' : '://shared-task/join') + '?invitation=' + encodeURIComponent(token) + '&server=' + encodeURIComponent(server);
  el('download').href = app === 'cindycn' ? 'https://cindy.com.cn' : 'https://cindy.app';
  el('actions').hidden = false;
  el('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(server + suffix + page.hash);
      el('status').textContent = guidance[mobile ? 5 : 6];
    }
    catch { el('status').textContent = text[8]; }
  });
  // Browsers may require a gesture for custom protocols. The visible link always remains available.
  try { location.href = el('open').href; } catch { /* The user can retry with the button. */ }
  // A remaining page is not proof of failure. Offer a neutral next step without claiming success.
  setTimeout(() => {
    el('title').textContent = guidance[0];
    el('intro').textContent = guidance[1];
    document.title = 'Cindy · ' + guidance[0];
  }, 1500);
})();`;
