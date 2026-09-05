import nodePath from 'node:path';

import {
  parseBrowserProxyServer,
  type BrowserRuntimeConfig,
} from '@cindy/browser-control-runtime';

/**
 * Managed profile identity. The profile key is the on-disk folder
 * `browser/<key>/user-data`. Chrome's top-right chip follows `displayName` when
 * set, otherwise the key. Isolated and snapshot profiles both pass
 * `displayName: "Cindy"` so the chip never shows the disk identifier. The runtime
 * seeds name + color into Local State / Preferences before launch (decoration
 * re-checks every launch, so an old chip label self-heals on first run).
 * (Same Chrome binary as the user's, so the dock/taskbar icon is unchanged.)
 *
 * ⚠️ 磁盘标识符:这是 2026-07 品牌翻转时钉死的目录名,之后【不要】再跟随
 * @cindy/maker-shared/branding 的 BRAND_NAME 变化——改了会指向新的空 profile
 * 目录,丢失既有登录态/Cookie。老 profile 的接续路径:
 *  - 老 userData(xdt-maker)里的 `browser-runtime/browser/XDMaker` 由 mToc 首登
 *    迁移(legacyUserDataMigration.ts)复制为新 userData 的 `browser/Cindy`;
 *  - 新 userData 里若已有旧名目录(翻转前的 dev 实例),browser.ts module-eval 的
 *    就地改名自愈处理。两处的 'XDMaker'/'Cindy' 字面量与本常量保持一致。
 */
export const MANAGED_PROFILE = 'Cindy';

/**
 * Snapshot profile for consented "use my browser logins". Disk name is pinned
 * like `Cindy` — do not rename, or leftover cookie copies become unreachable
 * and cleanup will miss them. Never overlay onto `MANAGED_PROFILE`. The Chrome
 * chip still shows `MANAGED_PROFILE` via `displayName`; this string is not
 * user-facing.
 */
export const REAL_MANAGED_PROFILE = 'Cindy-real';

/**
 * Fixed brand tint for the managed profile. This intentionally stays on the vivid
 * teal variant instead of the Default Light auto-approval text color. NOTE:
 * Chrome treats this as a *seed* and generates a tonal toolbar theme from it (Material
 * You), so it is NOT painted literally — but a SATURATED hue like this renders as a
 * clean teal, unlike a neutral/near-black seed which Chrome muddies into a grey-blue.
 * (The darker #000050 variant is near-neutral and would muddy, so we use #00D9C5.)
 */
const DEFAULT_PROFILE_COLOR = '#00D9C5';

/**
 * Vendored "managed launch" driver enum value (required by the runtime to mark a
 * profile as launch-and-own vs attach-to-existing). It DOES surface in the
 * `profiles`/`status`/`doctor` diagnostic output, so the runtime scrubs the
 * vendored brand from those success bodies at its boundary (see runtime.ts
 * DIAGNOSTIC_ACTIONS) — the agent never sees the raw "openclaw" string.
 */
const MANAGED_DRIVER = 'openclaw' as const;

/**
 * Managed Chrome CDP port. The runtime only auto-assigns a port to its built-in
 * default profile (keyed by the vendored default name); a custom-named managed
 * profile MUST define its own `cdpPort` or the runtime rejects it with "must define
 * cdpPort or cdpUrl". 18800 is the vendored default CDP port-range start.
 */
export const MANAGED_CDP_PORT = 18800;

/** Loopback CDP URL + on-disk profile used by the request-gate coordinator. */
export function managedBrowserGuardIdentity(input: {
  runtimeDir: string;
  useRealProfile: boolean;
  cdpPort?: number;
}): { cdpHttpUrl: string; managedUserDataDir: string } {
  const profile = input.useRealProfile ? REAL_MANAGED_PROFILE : MANAGED_PROFILE;
  const cdpPort = input.cdpPort ?? MANAGED_CDP_PORT;
  return {
    cdpHttpUrl: `http://127.0.0.1:${cdpPort}`,
    managedUserDataDir: nodePath.join(input.runtimeDir, 'browser', profile, 'user-data'),
  };
}

export interface ManagedBrowserConfigOptions {
  /** Credential-free launch proxy URL. Credentials stay in the host auth coordinator. */
  proxyServer?: string;
  /** Public DNS patterns allowed for page navigation through the explicit proxy. */
  proxyAllowedHostnames?: readonly string[];
  /** Consent-gated snapshot of the user's everyday browser logins. */
  useRealProfile?: boolean;
  /** Chromium binary for the snapshot profile; omitted for the isolated profile. */
  executablePath?: string;
  /** Override the managed CDP port (used when Cindy-real relocates off 18800). */
  cdpPort?: number;
}

/**
 * Default ("managed") config: a single playwright-launched Chrome profile, headed,
 * with a STABLE persistent user-data-dir (logins survive across sessions). This is
 * the product default — a "dedicated persistent login automation browser".
 * (`browser-backend-settings-store` resolves `'external'` as the system default,
 * so this config is what a user who never touched the toggle gets.)
 *
 * SECURITY POSTURE:
 *  - Only the fake-IP ranges used by system proxies are exempted from the SSRF
 *    guard. This prevents Surge/Clash/sing-box DNS answers (198.18.0.0/15 or
 *    IPv6 ULA) from making ordinary public sites look like SSRF attempts while
 *    localhost, RFC1918, metadata, link-local, and other special-use addresses
 *    remain blocked.
 *  - Page-context `evaluate` (and recipe `evaluate` steps) run author/agent JS in
 *    Chromium, whose network stack is NOT subject to the Node SSRF guard — a
 *    same-origin `fetch` there can reach any host the browser can. This residual
 *    surface is accepted as inherent to browser automation (it's the same
 *    capability the `act:evaluate` tool already exposes), not a regression.
 */
/**
 * Launch arguments for a proxied start.
 *
 * The CDP guard cannot attach until Chrome's DevTools endpoint is up, so a
 * persistent profile restoring tabs (or starting a service worker) could emit
 * requests through the proxy during that window. Chrome therefore enforces the
 * allowlist itself from process start: a PAC script routes allowlisted hosts to
 * the proxy and returns an unreachable directive for everything else, so
 * pre-attach requests fail instead of egressing.
 *
 * PAC is the ONLY proxy flag. Chromium picks exactly one proxy mode from the
 * command line, in fixed precedence (`--no-proxy-server`, then
 * `--proxy-pac-url`, then `--proxy-auto-detect`, then `--proxy-server`;
 * ChromeCommandLinePrefStore::ApplyProxyMode), so a `--proxy-server` next to
 * the PAC would be dead configuration — and a reader who trusted it would
 * expect fixed-proxy semantics the browser never applies. The proxy address
 * lives inside the PAC directive instead, and the vendored mode detection
 * treats `--proxy-pac-url` as an explicit proxy route on its own.
 *
 * PAC is a launch-time floor, not the ceiling: the CDP guard still applies the
 * HTTPS-only rule, the same allowlist, and DNS-answer verification per request
 * once attached. Because CDP Fetch never sees WebSocket handshakes, PAC is
 * also the only layer that can refuse a private-address WSS target.
 */
function buildProxyLaunchArgs(
  proxyServer: string,
  allowedHostnames: readonly string[] | undefined,
): string[] {
  const patterns = allowedHostnames ?? [];
  // JSON-encode every host pattern: PAC is JavaScript, so the allowlist must
  // never be interpolated as raw source.
  const allowlistLiteral = JSON.stringify(patterns);
  const proxyLiteral = JSON.stringify(proxyServerToPacDirective(proxyServer));
  const pac = [
    'function FindProxyForURL(url, host){',
    `var a=${allowlistLiteral};`,
    // Encrypted-only, matching the CDP guard: a cleartext request must fail at
    // the launch floor too, not just once the coordinator has attached.
    // Chrome passes WebSocket URLs to PAC with their ws:/wss: scheme intact
    // (verified against Chrome 151), so wss:// must be admitted explicitly or
    // real-time apps on allowlisted hosts break — and CDP Fetch cannot rescue
    // them, since it does not intercept WebSocket handshakes.
    'var u=String(url||"").toLowerCase();',
    'if(u.slice(0,8)!=="https://"&&u.slice(0,6)!=="wss://")return "PROXY 0.0.0.0:0";',
    'host=(host||"").toLowerCase().replace(/\\.+$/,"");',
    // PAC-side address check. CDP Fetch never sees this traffic during the
    // pre-attach window, and never sees WebSocket handshakes at all, so the
    // request-level DNS gate in proxy.ts cannot cover either path.
    //
    // dnsResolve / isInNet are Netscape PAC builtins that Chromium implements:
    // https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling/Proxy_Auto-Configuration_PAC_file
    // dnsResolve is IPv4-only and returns "" on failure. Empty / unresolvable
    // answers fail closed (same as the CDP DNS gate). 198.18.0.0/15 is exempt
    // to match allowRfc2544BenchmarkRange (Clash/Surge/sing-box fake-IP).
    'function v4b(ip){',
    'if(isInNet(ip,"198.18.0.0","255.254.0.0"))return false;',
    'return isInNet(ip,"0.0.0.0","255.0.0.0")||isInNet(ip,"10.0.0.0","255.0.0.0")||isInNet(ip,"127.0.0.0","255.0.0.0")||isInNet(ip,"169.254.0.0","255.255.0.0")||isInNet(ip,"172.16.0.0","255.240.0.0")||isInNet(ip,"192.168.0.0","255.255.0.0")||isInNet(ip,"100.64.0.0","255.192.0.0")||isInNet(ip,"192.0.0.0","255.255.255.0")||isInNet(ip,"192.0.2.0","255.255.255.0")||isInNet(ip,"198.51.100.0","255.255.255.0")||isInNet(ip,"203.0.113.0","255.255.255.0")||isInNet(ip,"224.0.0.0","240.0.0.0")||isInNet(ip,"240.0.0.0","240.0.0.0");',
    '}',
    'function blocked(){',
    'var h=host;if(h.charAt(0)==="[")h=h.slice(1,h.length-1);',
    'if(h.indexOf(":")>=0){',
    'if(h==="::1"||h==="0:0:0:0:0:0:0:1")return true;',
    'if(h.slice(0,5)==="fe80:")return true;',
    'if(h.indexOf("::ffff:")===0)return v4b(h.slice(7));',
    'return false;',
    '}',
    'var ip=dnsResolve(host);',
    'if(!ip)return true;',
    'return v4b(ip);',
    '}',
    'for(var i=0;i<a.length;i++){',
    'var p=a[i].toLowerCase();',
    'if(p.indexOf("*.")===0){var s=p.slice(2);',
    'if(s&&host!==s&&host.length>s.length&&host.slice(-(s.length+1))==="."+s){',
    `if(blocked())return "PROXY 0.0.0.0:0";return ${proxyLiteral};}}`,
    'else if(host===p){',
    `if(blocked())return "PROXY 0.0.0.0:0";return ${proxyLiteral};}`,
    '}',
    // No DIRECT fallback: a blocked host must fail, never leak around the proxy.
    'return "PROXY 0.0.0.0:0";',
    '}',
  ].join('');
  return [
    `--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac, 'utf8').toString('base64')}`,
    // WebRTC negotiates over UDP outside the HTTP/SOCKS proxy, so neither the
    // PAC nor the CDP request gate observes it: an allowlisted page could open
    // an RTCPeerConnection and disclose the machine's real IP while the route
    // reports "proxied". This policy suppresses host candidates that would not
    // traverse the proxy (verified on Chrome 151: the LAN-IP host candidate is
    // emitted without it and absent with it). Note the flag has NO `--force-`
    // prefix — `--force-webrtc-ip-handling-policy` is silently ignored.
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

/** Render a canonical proxy URL as a PAC return directive. */
function proxyServerToPacDirective(proxyServer: string): string {
  const parsed = new URL(proxyServer);
  // `host` keeps IPv6 brackets (`[::1]:1080`). `hostname` strips them, which
  // produces an invalid PAC SOCKS/PROXY token.
  const hostPort = parsed.host;
  switch (parsed.protocol) {
    case 'https:':
      return `HTTPS ${hostPort}`;
    case 'socks5:':
    case 'socks:':
      return `SOCKS5 ${hostPort}`;
    case 'socks4:':
      return `SOCKS ${hostPort}`;
    default:
      return `PROXY ${hostPort}`;
  }
}

export function buildManagedConfig(options: ManagedBrowserConfigOptions = {}): BrowserRuntimeConfig {
  const route = parseBrowserProxyServer(options.proxyServer, options.proxyAllowedHostnames);
  const proxyServer = route.mode === 'proxied' ? route.server : undefined;
  const useRealProfile = options.useRealProfile === true;
  const defaultProfile = useRealProfile ? REAL_MANAGED_PROFILE : MANAGED_PROFILE;
  const executablePath = options.executablePath;
  const cdpPort = options.cdpPort ?? MANAGED_CDP_PORT;
  return {
    browser: {
      enabled: true,
      defaultProfile,
      headless: false, // headed so the user can see + log into sites
      ...(executablePath ? { executablePath } : {}),
      ...(proxyServer ? { extraArgs: buildProxyLaunchArgs(proxyServer, route.allowedHostnames) } : {}),
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        ...(route.allowedHostnames ? { hostnameAllowlist: [...route.allowedHostnames] } : {}),
      },
      profiles: {
        [defaultProfile]: {
          driver: MANAGED_DRIVER,
          color: DEFAULT_PROFILE_COLOR,
          cdpPort,
          displayName: MANAGED_PROFILE,
          ...(executablePath ? { executablePath } : {}),
        },
      },
    },
  };
}
