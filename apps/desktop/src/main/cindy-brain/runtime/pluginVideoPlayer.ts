/** Host-owned, opt-in video documents. No arbitrary URLs or HTML cross this API. */
export const VIDEO_PLAYER_PATH = '/__video_player__/bilibili';
export const VIDEO_PLAYER_SCRIPT_PATH = '/__video_player__/controller.js';
export const VIDEO_PLAYER_ORIGIN = 'https://player.bilibili.com';
export interface VideoFrame {
  url: string;
  parent: VideoFrame | null;
}
export interface VideoRequest {
  url: string;
  resourceType: string;
  frame?: VideoFrame | null;
}

/** Canonicalize only video identifiers and a bounded part number; never accept a URL. */
export function videoPlayerUrl(query: URLSearchParams): string | null {
  const keys = [...query.keys()];
  if (
    keys.some((key) => !['bvid', 'aid', 'page'].includes(key)) ||
    new Set(keys).size !== keys.length
  )
    return null;
  const bvid = query.get('bvid'),
    aid = query.get('aid');
  if (Boolean(bvid) === Boolean(aid)) return null;
  if (bvid !== null && !/^BV[a-zA-Z0-9]{10}$/.test(bvid)) return null;
  if (aid !== null && !/^[1-9][0-9]{0,15}$/.test(aid)) return null;
  const page = query.get('page') ?? '1';
  if (!/^[1-9][0-9]{0,2}$/.test(page)) return null;
  const result = new URL('/player.html', VIDEO_PLAYER_ORIGIN);
  result.searchParams.set(bvid ? 'bvid' : 'aid', bvid || aid!);
  result.searchParams.set('page', page);
  result.searchParams.set('autoplay', '0');
  return result.href;
}
function safeHttps(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}
export function isOfficialVideoUrl(input: string): boolean {
  const url = safeHttps(input);
  if (!url || url.origin !== VIDEO_PLAYER_ORIGIN || url.pathname !== '/player.html' || url.hash)
    return false;
  const query = new URLSearchParams(url.search);
  if (query.getAll('autoplay').length !== 1 || query.get('autoplay') !== '0') return false;
  query.delete('autoplay');
  return videoPlayerUrl(query) === input;
}
export function isVideoWrapper(input: string, selfPrefix: string): boolean {
  if (!input.startsWith(selfPrefix)) return false;
  try {
    const url = new URL(input);
    return (
      url.pathname === VIDEO_PLAYER_PATH && !url.hash && videoPlayerUrl(url.searchParams) !== null
    );
  } catch {
    return false;
  }
}
/** Reject descendants too, including about:blank. Disposal cannot grant access. */
export function isVideoPlayerDescendant(
  frame: VideoFrame | null | undefined,
  selfPrefix: string,
): boolean {
  try {
    for (let current = frame, depth = 0; current && depth++ < 32; current = current.parent) {
      if (
        isOfficialVideoUrl(current.url) ||
        (current.parent && isVideoWrapper(current.parent.url, selfPrefix))
      )
        return true;
    }
    return false;
  } catch {
    return true;
  }
}
function approvedPlayerFrame(frame: VideoFrame | null | undefined, selfPrefix: string): boolean {
  if (
    !frame ||
    !isOfficialVideoUrl(frame.url) ||
    !frame.parent ||
    !isVideoWrapper(frame.parent.url, selfPrefix)
  )
    return false;
  const parent = frame.parent.parent;
  return !!parent && parent.parent === null && parent.url.startsWith(selfPrefix);
}
/** Remote frames never inherit Host routes; referrer is deliberately not an input. */
export function videoRequestAllowed(details: VideoRequest, selfPrefix: string): boolean {
  try {
    const url = safeHttps(details.url);
    if (!url || details.resourceType === 'mainFrame') return false;
    if (details.resourceType === 'subFrame') {
      const wrapper = details.frame?.parent;
      if (
        !wrapper ||
        !isVideoWrapper(wrapper.url, selfPrefix) ||
        !wrapper.parent ||
        wrapper.parent.parent !== null ||
        !wrapper.parent.url.startsWith(selfPrefix)
      )
        return false;
      return videoPlayerUrl(new URL(wrapper.url).searchParams) === details.url;
    }
    if (!approvedPlayerFrame(details.frame, selfPrefix)) return false;
    const staticHost = /^(?:s[1-3]|i[0-2])\.hdslb\.com$/.test(url.hostname);
    const mediaHost = /^(?:[a-z0-9-]+\.)+bilivideo\.(?:com|cn)$/.test(url.hostname);
    switch (details.resourceType) {
      case 'script':
      case 'stylesheet':
      case 'font':
      case 'image':
        return staticHost || url.origin === VIDEO_PLAYER_ORIGIN;
      case 'xhr':
        return (
          url.hostname === 'api.bilibili.com' ||
          staticHost ||
          mediaHost ||
          url.origin === VIDEO_PLAYER_ORIGIN
        );
      case 'media':
        return mediaHost;
      default:
        return false;
    }
  } catch {
    return false;
  }
}
/** null preserves ordinary plugin networking; false must never fall through to it. */
export function videoRequestDecision(
  details: VideoRequest,
  selfPrefix: string,
  current: boolean,
  panel: boolean,
): boolean | null {
  try {
    if (!details.frame && details.resourceType !== 'mainFrame') return false;
    if (
      isVideoPlayerDescendant(details.frame, selfPrefix) ||
      (details.resourceType === 'subFrame' && isOfficialVideoUrl(details.url))
    ) {
      return current && panel && videoRequestAllowed(details, selfPrefix);
    }
    return null;
  } catch {
    return false;
  }
}

/** Mandatory response restrictions survive removal of iframe DOM attributes. */
export const VIDEO_RESPONSE_CSP =
  "sandbox allow-scripts allow-same-origin; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src blob:";
export const VIDEO_PERMISSIONS_POLICY =
  'autoplay=(), camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), fullscreen=()';
export function videoPlayerDocument(
  query: URLSearchParams,
  playLabel = 'Play video',
): string | null {
  const target = videoPlayerUrl(query);
  if (!target) return null;
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    ':root{color-scheme:light dark}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--panel-bg,Canvas);color:var(--text-primary,CanvasText)}body{display:grid;place-items:center}button{font:inherit;min-width:44px;min-height:44px;border:1px solid var(--border-default,ButtonBorder);border-radius:9999px;color:var(--text-primary,ButtonText);background:var(--surface,ButtonFace);cursor:pointer}iframe{width:100%;height:100%;border:0}' +
    '</style></head><body><button type="button" aria-label="' +
    playLabel.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') +
    '">▶</button><template data-player="' +
    target.replaceAll('&', '&amp;') +
    '"></template><script src="' +
    VIDEO_PLAYER_SCRIPT_PATH +
    '"></script></body></html>'
  );
}
/** Served as a local script, never inline; removing the outer iframe destroys playback. */
export const VIDEO_PLAYER_SCRIPT = String.raw`(() => {
  const button = document.querySelector('button');
  const template = document.querySelector('template');
  let themeObserver;
  const copyTheme = () => {
    try {
      const styles = getComputedStyle(parent.document.documentElement);
      document.documentElement.style.colorScheme = styles.colorScheme;
      for (const key of ['--panel-bg', '--text-primary', '--border-default', '--surface']) {
        document.documentElement.style.setProperty(key, styles.getPropertyValue(key));
      }
    } catch {}
  };
  copyTheme();
  parent.addEventListener('cindy:theme-changed', copyTheme);
  try {
    themeObserver = new MutationObserver(copyTheme);
    themeObserver.observe(parent.document.documentElement, {attributes:true, attributeFilter:['style','class']});
  } catch {}
  button.addEventListener('click', event => {
    if (!event.isTrusted || document.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.title = 'Bilibili';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('allow', "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'");
    frame.referrerPolicy = 'no-referrer';
    frame.src = template.dataset.player;
    button.replaceWith(frame);
  });
  addEventListener('pagehide', () => { themeObserver?.disconnect(); parent.removeEventListener('cindy:theme-changed', copyTheme); document.querySelector('iframe')?.remove(); });
})();`;
