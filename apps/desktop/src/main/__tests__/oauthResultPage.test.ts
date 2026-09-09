import { describe, expect, it } from 'vitest';

import { LOGIN_CALLBACK_CHIBI } from '../assets/loginCallbackAssets';

import {
  buildOAuthReturnAction,
  getGhostOAuthResultCopy,
  getOAuthNeutralResultCopy,
  getProviderOAuthResultCopy,
  OAUTH_RESULT_HTML_LANG,
  pickOAuthResultPageLang,
  renderOAuthResultPage,
  type OAuthResultPageLang,
} from '../oauthResultPage';

const ALL_OAUTH_LANGS: OAuthResultPageLang[] = ['zh', 'zh-TW', 'en', 'ja', 'ko'];

describe('OAuth result page language and copy', () => {
  it('uses the first supported browser language and falls back to English', () => {
    expect(pickOAuthResultPageLang('fr-FR,ja;q=0.8,en;q=0.7')).toBe('ja');
    expect(pickOAuthResultPageLang('zh-TW,zh;q=0.9')).toBe('zh-TW');
    expect(pickOAuthResultPageLang('de-DE')).toBe('en');
    expect(pickOAuthResultPageLang(undefined)).toBe('en');
  });

  it('recognizes Traditional Chinese variants', () => {
    expect(pickOAuthResultPageLang('zh-Hant')).toBe('zh-TW');
    expect(pickOAuthResultPageLang('zh-HK')).toBe('zh-TW');
    expect(pickOAuthResultPageLang('zh-MO')).toBe('zh-TW');
    expect(pickOAuthResultPageLang('zh-Hant-TW,zh;q=0.8')).toBe('zh-TW');
    expect(pickOAuthResultPageLang('ZH-HANT-HK')).toBe('zh-TW');
  });

  it('keeps Simplified Chinese for zh / zh-CN / explicit Hans script tags', () => {
    expect(pickOAuthResultPageLang('zh')).toBe('zh');
    expect(pickOAuthResultPageLang('zh-CN,zh;q=0.9')).toBe('zh');
    expect(pickOAuthResultPageLang('zh-Hans')).toBe('zh');
    // An explicit Hans script subtag wins over a Traditional-default region.
    expect(pickOAuthResultPageLang('zh-Hans-HK')).toBe('zh');
  });

  it('honors browser preference order over Traditional Chinese recognition', () => {
    expect(pickOAuthResultPageLang('ja,zh-TW;q=0.9')).toBe('ja');
    expect(pickOAuthResultPageLang('fr-FR,zh-Hant;q=0.8,en;q=0.5')).toBe('zh-TW');
  });

  it('maps every callback language to a BCP 47 html lang value', () => {
    for (const lang of ALL_OAUTH_LANGS) {
      expect(OAUTH_RESULT_HTML_LANG[lang]).toBeTruthy();
    }
    expect(OAUTH_RESULT_HTML_LANG.zh).toBe('zh-CN');
    expect(OAUTH_RESULT_HTML_LANG['zh-TW']).toBe('zh-TW');
  });

  it('builds a localized return-to-Cindy deep link', () => {
    expect(buildOAuthReturnAction('zh', 'xai oauth', 'Cindy')).toEqual({
      href: 'cindy://focus/xai%20oauth',
      label: '返回 Cindy',
    });
    expect(buildOAuthReturnAction('en', 'generic-oauth', 'Cindy').label).toBe('Return to Cindy');
  });

  it('provides provider-specific localized result copy', () => {
    const copy = getProviderOAuthResultCopy('zh', 'xAI', 'Cindy');
    expect(copy.successBody).toContain('xAI');
    expect(copy.successBody).toContain('Cindy');
    expect(copy.exchangeFailedBody).toContain('连接 xAI');
  });

  it('provides complete provider copy for all callback languages', () => {
    for (const lang of ALL_OAUTH_LANGS) {
      const copy = getProviderOAuthResultCopy(lang, 'xAI', 'Cindy');
      for (const value of Object.values(copy)) {
        expect(value).toBeTruthy();
      }
    }
  });

  it('localizes the return action for English', () => {
    expect(buildOAuthReturnAction('en', 'ghost-oauth', 'Cindy')).toEqual({
      href: 'cindy://focus/ghost-oauth',
      label: 'Return to Cindy',
    });
  });
});

describe('shared ghost OAuth callback copy (生产/preview 合一)', () => {
  it('provides complete ghost copy with placeholders for all languages', () => {
    for (const lang of ALL_OAUTH_LANGS) {
      const copy = getGhostOAuthResultCopy(lang);
      expect(copy.successTitle).toBeTruthy();
      expect(copy.successBody).toContain('{brand}');
      expect(copy.errorTitle).toBeTruthy();
      expect(copy.errors['provider-error']).toContain('{detail}');
      expect(copy.errors['invalid-callback']).toContain('{brand}');
      expect(copy.errors.internal).toContain('{brand}');
    }
  });
});

describe('neutral callback copy (demo CALLBACK.neutral verbatim)', () => {
  it('matches the localized copy character-for-character', () => {
    expect(getOAuthNeutralResultCopy('zh', 'Cindy')).toEqual({
      title: '需要继续操作',
      body: '请返回 Cindy，完成当前工作区的安装后继续。',
    });
    expect(getOAuthNeutralResultCopy('zh-TW', 'Cindy')).toEqual({
      title: '需要繼續操作',
      body: '請返回 Cindy，完成目前工作區的安裝後繼續。',
    });
    expect(getOAuthNeutralResultCopy('en', 'Cindy')).toEqual({
      title: 'Action required',
      body: 'Return to Cindy and finish installing in the current workspace.',
    });
    expect(getOAuthNeutralResultCopy('ja', 'Cindy')).toEqual({
      title: '操作が必要です',
      body: 'Cindy に戻り、現在のワークスペースへのインストールを完了してください。',
    });
    expect(getOAuthNeutralResultCopy('ko', 'Cindy')).toEqual({
      title: '추가 작업 필요',
      body: 'Cindy로 돌아가 현재 워크스페이스 설치를 완료하세요.',
    });
  });

  it('interpolates the brand name instead of hardcoding it', () => {
    for (const lang of ALL_OAUTH_LANGS) {
      expect(getOAuthNeutralResultCopy(lang, 'BrandX').body).toContain('BrandX');
    }
  });
});

describe('renderOAuthResultPage', () => {
  it.each(['success', 'warning', 'error'] as const)(
    'marks and renders the %s variant',
    (variant) => {
      const html = renderOAuthResultPage({
        htmlLang: 'en',
        variant,
        title: 'Result',
        body: 'Result body',
      });
      expect(html).toContain(`data-cindy-oauth-result="${variant}"`);
      expect(html).toContain('<svg');
    },
  );

  it('supports forced light and dark themes for local visual previews', () => {
    expect(
      renderOAuthResultPage({
        htmlLang: 'en',
        variant: 'success',
        title: 'Done',
        body: 'Done',
        theme: 'light',
      }),
    ).toContain('<html lang="en" data-theme="light">');
    expect(
      renderOAuthResultPage({
        htmlLang: 'en',
        variant: 'success',
        title: 'Done',
        body: 'Done',
        theme: 'dark',
      }),
    ).toContain('<html lang="en" data-theme="dark">');
  });

  it('escapes all caller-controlled text and action fields', () => {
    const html = renderOAuthResultPage({
      htmlLang: 'en"><script>',
      variant: 'error',
      title: '<Title>',
      body: '<Body>',
      detail: '<script>alert(1)</script>',
      action: { href: 'cindy://focus/test" onclick="bad()', label: '<Return>' },
    });
    expect(html).toContain('lang="en&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('&lt;Title&gt;');
    expect(html).toContain('&lt;Body&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="cindy://focus/test&quot; onclick=&quot;bad()"');
    expect(html).toContain('&lt;Return&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders the return action and responsive card shell', () => {
    const html = renderOAuthResultPage({
      htmlLang: 'zh-CN',
      variant: 'warning',
      title: '需要继续操作',
      body: '请返回 Cindy。',
      action: { href: 'cindy://focus/slack-hook-install', label: '返回 Cindy' },
    });
    expect(html).toContain('<a class="cta" href="cindy://focus/slack-hook-install">返回 Cindy</a>');
    expect(html).toContain('@media(max-width:480px)');
    expect(html).toContain('border-radius:12px');
  });
});

// ── PR3:wave4 新品牌卡(pageKind='desktop-login')与三层 adapter ──────────────

const BRAND_BASE = {
  htmlLang: 'zh-CN',
  title: '登录成功',
  body: '登录已成功，现在可以关闭此页面了。',
  closeCountdown: '{{count}}秒后自动关闭',
  action: { href: 'cindy://focus/desktop-login', label: '回到 Cindy' },
} as const;

describe('wave4 brand login callback card (pageKind=desktop-login)', () => {
  it('renders the compact success card with the frozen U-10 scale formula', () => {
    const html = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'success',
      pageKind: 'desktop-login',
    });
    // 成功态移除 CTA 后使用紧凑流式卡,避免沿用失败态卡片的底部空白。
    expect(html).toContain('data-cindy-oauth-layout="compact"');
    expect(html).toContain('data-card-width="560" data-card-height="500"');
    expect(html).toContain('.card.success{width:560px;height:500px;display:flex;flex-direction:column;align-items:center;padding:48px 40px 44px}');
    expect(html).toContain('.card.success .visual{position:static;flex:0 0 240px;width:240px;height:240px}');
    expect(html).toContain('.card.success .content{display:flex;flex-direction:column;align-items:center;width:100%;margin-top:24px;gap:10px}');
    expect(html).toContain('.card.success .body{position:static;flex:0 0 auto;width:100%;max-width:480px;height:auto;min-height:28px;margin:0;font-size:20px;line-height:28px;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}');
    expect(html).toContain('.card.success .close-countdown{flex:0 0 auto;margin:auto 0 0;color:var(--detail);font-size:16px;line-height:23px;text-align:center;white-space:nowrap}');
    expect(html).toContain('id="close-countdown" data-template="{{count}}秒后自动关闭">3秒后自动关闭</p>');
    expect(html).not.toContain('尝试自动关闭');
    expect(html).toContain('border-radius:36px');
    // U-10 demo 冻结公式逐字面出现在内联脚本中
    expect(html).toContain('w<760?88:80');
    expect(html).toContain('Math.min(1,(w-32)/cardWidth,(h-topOffset-24)/cardHeight)');
    // chibi data URI(U-7)+ 加载失败降级
    expect(html).toContain(LOGIN_CALLBACK_CHIBI.success.slice(0, 64));
    expect(html).toContain('onerror=');
    expect(html).toContain('data-cindy-oauth-visual="success"');
    expect(html).toContain("document.body.dataset.cindyOauthResult==='success'");
    expect(html).toContain('var remaining=3,timer');
    expect(html).toContain('remaining-=1');
    expect(html).toContain('countdown.remove()');
    expect(html).toContain('window.close()');
    expect(html).not.toContain('<a class="cta"');
  });

  it('keeps the return CTA on branded error pages', () => {
    const html = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'error',
      title: '登录未完成',
      body: '请回到 Cindy 重新登录。',
    });
    expect(html).toContain('<a class="cta" href="cindy://focus/desktop-login">回到 Cindy</a>');
    expect(html).not.toContain('id="close-countdown"');
  });

  it('maps legacy variants to visual kinds (error→failure, warning→neutral)', () => {
    const failure = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'error',
      pageKind: 'desktop-login',
    });
    expect(failure).toContain('data-cindy-oauth-visual="failure"');
    expect(failure).toContain(LOGIN_CALLBACK_CHIBI.failure.slice(0, 64));
    const neutral = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'warning',
      pageKind: 'desktop-login',
    });
    expect(neutral).toContain('data-cindy-oauth-visual="neutral"');
    expect(neutral).toContain(LOGIN_CALLBACK_CHIBI.neutral.slice(0, 64));
  });

  it('honors explicit visualKind and emits the copyKind acceptance label', () => {
    const html = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'success',
      pageKind: 'desktop-login',
      visualKind: 'neutral',
      copyKind: 'callback.neutral',
    });
    expect(html).toContain('data-cindy-oauth-visual="neutral"');
    expect(html).toContain(LOGIN_CALLBACK_CHIBI.neutral.slice(0, 64));
    expect(html).toContain('data-cindy-oauth-copy="callback.neutral"');
  });

  it('keeps every non-login caller on the legacy shell (ghost/claude/xai/generic 视觉零变化)', () => {
    for (const pageKind of [
      undefined,
      'ghost-oauth',
      'claude-oauth',
      'xai-oauth',
      'generic-oauth',
    ] as const) {
      const html = renderOAuthResultPage({ ...BRAND_BASE, variant: 'success', pageKind });
      expect(html).toContain('<span class="badge"');
      expect(html).not.toContain('data-cindy-oauth-visual');
      expect(html).not.toContain('data:image/webp');
      expect(html).not.toContain('w<760?88:80');
    }
  });

  it('renders both forced themes and the prefers-color-scheme dual palette', () => {
    const light = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'success',
      pageKind: 'desktop-login',
      theme: 'light',
    });
    expect(light).toContain('<html lang="zh-CN" data-theme="light">');
    // 页面底色浅 #EEEEEE/深 #2A2828(design §7.4 条 1),卡底 #FBFBFB/#312F2F
    expect(light).toContain('--page:#eeeeee');
    expect(light).toContain('--card:#fbfbfb');
    const dark = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'success',
      pageKind: 'desktop-login',
      theme: 'dark',
    });
    expect(dark).toContain('<html lang="zh-CN" data-theme="dark">');
    expect(dark).toContain('--page:#2a2828');
    expect(dark).toContain('--card:#312f2f');
  });

  it('callback success/failure/neutral:forced light/dark themes render acceptance states', () => {
    const cases = [
      { variant: 'success' as const, visualKind: 'success' },
      { variant: 'error' as const, visualKind: 'failure' },
      { variant: 'warning' as const, visualKind: 'neutral' },
    ];
    for (const { variant, visualKind } of cases) {
      for (const theme of ['light', 'dark'] as const) {
        const html = renderOAuthResultPage({
          ...BRAND_BASE,
          variant,
          pageKind: 'desktop-login',
          theme,
        });
        expect(html).toContain(`data-theme="${theme}"`);
        expect(html).toContain(`data-cindy-oauth-visual="${visualKind}"`);
        if (variant === 'success') {
          expect(html).toContain('width:560px;height:500px');
          expect(html).toContain('data-card-width="560" data-card-height="500"');
        } else {
          expect(html).toContain('width:680px;height:680px');
          expect(html).toContain('data-card-width="680" data-card-height="680"');
          expect(html).toContain('left:70px;top:529px;width:540px;height:80px;border-radius:40px');
        }
      }
    }
  });

  it('escapes all caller-controlled fields on the brand card branches', () => {
    const html = renderOAuthResultPage({
      htmlLang: 'zh"><script>',
      variant: 'error',
      pageKind: 'desktop-login',
      copyKind: '"><img src=x onerror=alert(2)>',
      title: '<Title>',
      body: '<Body>',
      detail: '<script>alert(1)</script>',
      action: { href: 'cindy://focus/login" onclick="bad()', label: '<Return>' },
    });
    expect(html).toContain('lang="zh&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('data-cindy-oauth-copy="&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"');
    expect(html).toContain('&lt;Title&gt;');
    expect(html).toContain('&lt;Body&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="cindy://focus/login&quot; onclick=&quot;bad()"');
    expect(html).toContain('&lt;Return&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
  });

  it('escapes injected provider names flowing through provider copy into the shell', () => {
    const copy = getProviderOAuthResultCopy('en', '<img src=x onerror=alert(3)>', 'Cindy');
    const html = renderOAuthResultPage({
      htmlLang: 'en',
      variant: 'error',
      title: copy.errorTitle,
      body: copy.exchangeFailedBody,
    });
    expect(html).toContain('&lt;img src=x onerror=alert(3)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('renders detail as a single escaped error-code line (U-2), surviving long Unicode and newlines', () => {
    const longDetail = `${'非常长的Unicode错误码🧨'.repeat(200)}\nSECOND_LINE<script>alert(1)</script>`;
    const html = renderOAuthResultPage({
      ...BRAND_BASE,
      variant: 'error',
      pageKind: 'desktop-login',
      detail: longDetail,
    });
    // 单行契约:detail 样式冻结为 nowrap + ellipsis(错误码单行,现网行为)
    expect(html).toContain(
      '.detail{position:absolute;left:41px;top:434px;width:599px;margin:0;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;color:var(--detail);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('非常长的Unicode错误码🧨');
  });
});
