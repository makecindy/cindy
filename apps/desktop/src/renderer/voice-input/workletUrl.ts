// ?url 引入拿的是资产 URL;它必须始终是真实文件 URL,不能被 Vite 内联成
// `data:` URI —— AudioWorklet 脚本加载受 CSP `script-src` 管辖(见 main/security/
// csp.ts),prod 策略不含 data:,内联后 addModule() 必被拦截(issue #903)。
// 该文件(3.4KB)小于 Vite 默认内联阈值 4096B,禁止内联由 vite.renderer.config.ts
// 的 build.assetsInlineLimit 回调按 `*-worklet.js` 命名约定保证。
import rawPcm16kWorkletUrl from './pcm16k-worklet.js?url';

const ABSOLUTE_URL_RE = /^[a-z][a-z\d+\-.]*:/i;

export function resolveVoiceInputWorkletUrl(rawUrl: string, baseHref: string): string {
  if (ABSOLUTE_URL_RE.test(rawUrl)) return rawUrl;

  const baseUrl = new URL(baseHref);
  // Vite emits `?url` assets as root-relative paths in packaged builds. That
  // works on the dev server, but `file:///assets/...` is wrong after
  // BrowserWindow.loadFile(); the asset lives next to the packaged index.html.
  if (baseUrl.protocol === 'file:' && rawUrl.startsWith('/')) {
    return new URL(`.${rawUrl}`, baseUrl).toString();
  }
  return new URL(rawUrl, baseUrl).toString();
}

export function getVoiceInputWorkletUrl(): string {
  // AudioWorklet must load executable JavaScript. Importing the old TypeScript
  // worklet via `?url` made Vite package raw TS as a `data:video/mp2t` asset in
  // release builds; keeping the worklet as plain JS lets Vite emit a real JS
  // module while preserving normal AudioWorklet module loading semantics.
  if (typeof window === 'undefined' || !window.location?.href) {
    return rawPcm16kWorkletUrl;
  }
  return resolveVoiceInputWorkletUrl(rawPcm16kWorkletUrl, window.location.href);
}
