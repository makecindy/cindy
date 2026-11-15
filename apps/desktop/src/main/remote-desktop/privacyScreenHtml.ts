import illustration from '../../renderer/assets/splash/illustration.webp?inline';
import wordmark from '../../renderer/assets/splash/wordmark.png?inline';

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** Full brightness after the page (re)loads, then dimmed (docs/product-rules/privacy-screen.md). */
export const PRIVACY_SCREEN_BRIGHT_MS = 10_000;
/** One drift position is held this long, the move included. */
const DRIFT_STEP_S = 90;
/** Offsets in vw / vh around the centre; the content never leaves the middle of the screen. */
const DRIFT: Array<[number, number]> = [
  [0, 0],
  [6, -4],
  [-5, 5],
  [4, 6],
  [-6, -3],
  [3, -6],
  [-3, 3],
  [6, 2],
];

function driftKeyframes(reducedMotion: boolean): string {
  const step = 100 / DRIFT.length;
  // Moves take about a tenth of a step: slow enough to read as drifting, not jumping.
  const move = step / 9;
  const at = ([x, y]: [number, number]) => `transform:translate(${x}vw,${y}vh)`;
  const frames: string[] = [];
  DRIFT.forEach((position, index) => {
    const start = index * step;
    const hold = start + step - move;
    if (!reducedMotion) {
      frames.push(`${start.toFixed(2)}%,${hold.toFixed(2)}%{${at(position)}}`);
      return;
    }
    // Reduced motion: fade out, change place while invisible, fade in. No sliding.
    const next = DRIFT[(index + 1) % DRIFT.length];
    frames.push(
      `${start.toFixed(2)}%,${hold.toFixed(2)}%{${at(position)};opacity:1}`,
      `${(hold + move / 2).toFixed(2)}%{${at(position)};opacity:0}`,
      `${(hold + move / 2 + 0.01).toFixed(2)}%{${at(next)};opacity:0}`,
    );
  });
  frames.push(`100%{${at(DRIFT[0])}${reducedMotion ? ';opacity:1' : ''}}`);
  return frames.join('');
}

/**
 * The privacy screen, the same in every scene (away, after a remote session, during
 * one): black so the display reads as off (OLED pixels and local-dimming zones stay
 * dark), with the Cindy illustration and a status line so anyone nearby knows what is
 * going on. The bright parts are protected from burn-in: full brightness for ten
 * seconds after the page loads (Main reloads it when someone moves the pointer), then
 * dimmed to about a third, and the whole group drifts slowly around the centre.
 * Functional pixels, independent of the light / dark theme. Bundled artwork only: the
 * privacy partition never needs file or network access, and the page runs no script.
 */
export function privacyScreenHtml(status: string, hint: string): string {
  const total = DRIFT_STEP_S * DRIFT.length;
  const brightS = PRIVACY_SCREEN_BRIGHT_MS / 1000;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#e5e5e5}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;cursor:none;display:grid;place-items:center;padding:40px}
.dim{animation:dim 1500ms ease-in-out ${brightS}s forwards}
.drift{animation:drift ${total}s ease-in-out ${brightS}s infinite}
main{width:min(1000px,80vw);display:flex;align-items:center;justify-content:center;gap:clamp(24px,4vw,72px)}
.hero{width:min(36vw,48vh,480px);height:auto;flex-shrink:0}
.copy{max-width:420px}
.wordmark{display:block;width:clamp(140px,15vw,200px);height:auto;margin-bottom:28px}
h1{font-size:clamp(20px,2vw,28px);font-weight:500;line-height:1.5;letter-spacing:-.02em;margin:0;text-wrap:balance}
p{font-size:14px;line-height:1.8;color:#a3a3a3;margin:16px 0 0;text-wrap:balance}
@keyframes dim{to{opacity:.3}}
@keyframes drift{${driftKeyframes(false)}}
@keyframes hop{${driftKeyframes(true)}}
@media(prefers-reduced-motion:reduce){.drift{animation-name:hop;animation-timing-function:linear}}
@media(max-aspect-ratio:1/1){main{flex-direction:column;gap:16px;text-align:center}.hero{width:min(60vw,40vh)}.wordmark{margin:0 auto 20px}.copy{max-width:80vw}h1{font-size:20px}}
</style></head><body><div class="dim"><div class="drift"><main>
<img class="hero" src="${illustration}" alt="">
<section class="copy"><img class="wordmark" src="${wordmark}" alt="Cindy">
<h1>${escapeHtml(status)}</h1><p>${escapeHtml(hint)}</p></section>
</main></div></div></body></html>`;
}
