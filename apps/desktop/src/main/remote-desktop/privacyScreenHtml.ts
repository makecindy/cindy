import illustration from '../../renderer/assets/splash/illustration.webp?inline';
import wordmarkDark from '../../renderer/assets/splash/wordmark.png?inline';
import wordmarkLight from '../../renderer/assets/splash/wordmark-light.png?inline';

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** Bundled artwork only: the privacy partition never needs file or network access. */
export function privacyScreenHtml(status: string, hint: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
/* Isolated surface: mirrors the built-in surface/text semantic tokens. */
:root{color-scheme:light dark;--surface:#f8f8f6;--text-primary:#262626;--text-secondary:#737373}
@media(prefers-color-scheme:dark){:root{--surface:#1f1f1e;--text-primary:#d4d4d4;--text-secondary:#a3a3a3}}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--surface);color:var(--text-primary)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;display:grid;place-items:center;padding:40px}
main{width:min(1100px,92vw);display:flex;align-items:center;justify-content:center;gap:clamp(24px,4vw,72px)}
.hero{width:min(48vw,62vh,600px);height:auto;flex-shrink:0;animation:arrive 650ms ease-out both}
.copy{max-width:460px;animation:arrive 650ms 100ms ease-out both}
.wordmark{display:block;width:clamp(160px,18vw,230px);height:auto;margin-bottom:32px}
h1{font-size:clamp(21px,2.2vw,32px);font-weight:500;line-height:1.5;letter-spacing:-.02em;margin:0;text-wrap:balance}
p{font-size:14px;line-height:1.8;color:var(--text-secondary);margin:20px 0 0;text-wrap:balance}
@keyframes arrive{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.hero,.copy{animation:none}}
@media(max-aspect-ratio:1/1){main{flex-direction:column;gap:16px;text-align:center}.hero{width:min(68vw,46vh)}.wordmark{margin:0 auto 20px}.copy{max-width:85vw}h1{font-size:22px}}
</style></head><body><main>
<img class="hero" src="${illustration}" alt="">
<section class="copy"><picture><source media="(prefers-color-scheme:dark)" srcset="${wordmarkDark}"><img class="wordmark" src="${wordmarkLight}" alt="Cindy"></picture>
<h1>${escapeHtml(status)}</h1><p>${escapeHtml(hint)}</p></section>
</main></body></html>`;
}

/**
 * Away guard cover: as close to a switched-off display as an awake one can get. One
 * quiet line says what is going on, then fades so the screen is plain black (dark
 * pixels on OLED panels emit nothing). Functional pixels, independent of the theme.
 */
export function awayScreenHtml(status: string, hint: string, fade = true): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#8a8a8a}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;display:grid;place-items:center;padding:40px;cursor:none}
main{text-align:center;max-width:520px${fade ? ';animation:fade 1200ms ease-in 6s forwards' : ''}}
h1{font-size:15px;font-weight:500;line-height:1.5;margin:0}
p{font-size:13px;line-height:1.5;color:#5c5c5c;margin:8px 0 0}
@keyframes fade{to{opacity:0}}
${fade ? '@media(prefers-reduced-motion:reduce){main{animation:hide 0s 6s forwards}@keyframes hide{to{opacity:0}}}' : ''}
</style></head><body><main>
<h1>${escapeHtml(status)}</h1><p>${escapeHtml(hint)}</p>
</main></body></html>`;
}
