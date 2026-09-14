import { DESKTOP_VIEWER_SOURCE } from "./viewerSource";

export function remoteDesktopViewerHtml(
  surface: string,
  foreground: string,
  config: { net: unknown; iceServers: unknown; keyCodes: readonly string[] },
): string {
  // Only theme token colors enter markup. No device names, SDP, or remote HTML.
  const color = (v: string) =>
    /^#[0-9a-f]{3,8}$/i.test(v) ? v : "transparent";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:; connect-src 'none'"><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${color(surface)};touch-action:none;overscroll-behavior:none}#stage{position:absolute;inset:0;overflow:hidden;z-index:0}video,img{position:absolute;max-width:none;pointer-events:none;transform-origin:0 0}video{display:none;z-index:0}#cursor{position:absolute;z-index:3;width:18px;height:18px;border:2px solid ${color(foreground)};border-radius:50%;pointer-events:none;display:none;transform:translate(-50%,-50%)}
  #cursor-image{position:absolute;inset:0;width:100%;height:100%}
  #stage,#stage *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none}
  video,img{border:0;outline:0}#image{z-index:1}img:not([src]){visibility:hidden}
  :root{--surface:${color(surface)};--foreground:${color(foreground)}}
  #keyboard-input{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px;pointer-events:none;border:0;padding:0;resize:none}
  #mouse-buttons{position:absolute;inset:0;pointer-events:none;display:none;color:var(--foreground);opacity:.85}
  #mouse-buttons button,#mouse-wheel{pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;color:inherit;background:color-mix(in srgb,var(--surface) 90%,var(--foreground));border:1px solid color-mix(in srgb,var(--foreground) 18%,transparent)}
  .mouse-button{position:absolute;width:56px;height:56px;border-radius:9999px;padding:14px}
  .mouse-button svg{width:100%;height:100%;pointer-events:none}
  .mouse-button[aria-pressed="true"]{background:var(--foreground)!important;color:var(--surface)!important}
  #mouse-left{left:calc(50% - 96px);bottom:16px}#mouse-right{left:calc(50% + 40px);bottom:16px}
  #mouse-wheel{position:absolute;right:12px;bottom:80px;width:56px;height:120px;padding:12px 0;border-radius:9999px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;font-size:20px}
  #mouse-wheel:active{background:var(--foreground);color:var(--surface)}
  #mouse-wheel>*{pointer-events:none}
  #mouse-wheel-grip{width:20px;height:34px}
  @media(max-height:400px){#mouse-wheel{bottom:12px}}
  </style></head><body><div id="stage"><img id="image" alt=""><video id="video" autoplay muted playsinline></video><div id="cursor"><img id="cursor-image" alt=""></div></div>
  <div id="mouse-buttons">
    ${(["left", "right"] as const).map((button) => `<button type="button" id="mouse-${button}" class="mouse-button" aria-pressed="false"><svg viewBox="0 0 24 32" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="2" width="18" height="28" rx="9"/><path d="M12 2v12M3 14h18"/><path d="${button === "left" ? "M11 3C6 3 4 6 4 10v3h7Z" : "M13 3c5 0 7 3 7 7v3h-7Z"}" fill="currentColor" stroke="none"/></svg></button>`).join("")}
    <button type="button" id="mouse-wheel"><span aria-hidden="true">▴</span><svg id="mouse-wheel-grip" viewBox="0 0 20 34" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="1" y="1" width="18" height="32" rx="8"/><path d="M3 10h14M2 17h16M3 24h14"/></svg><span aria-hidden="true">▾</span></button>
  </div><textarea id="keyboard-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Keyboard"></textarea><script>
  ${DESKTOP_VIEWER_SOURCE}
  const viewer=mountRemoteDesktopViewer(document, message=>window.ReactNativeWebView.postMessage(JSON.stringify(message)),${JSON.stringify(config)});
  const receive=e=>{try{viewer.receive(JSON.parse(e.data));}catch{}};window.addEventListener('message',receive);document.addEventListener('message',receive);
  </script></body></html>`;
}
