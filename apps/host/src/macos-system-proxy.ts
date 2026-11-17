/**
 * macOS static system proxy settings for the Host (release table row 28, 28b).
 *
 * The desktop asks Chromium (`session.defaultSession.resolveProxy`), which reads
 * `SCDynamicStoreCopyProxies(NULL)` and applies the proxy rules per URL. The Host has no Chromium:
 * it reads the same dictionary through `scutil --proxy` (Apple configd: `SCDynamicStoreCopyProxies(NULL)`,
 * printed with SCPrint after dropping `__SCOPED__`, `__SERVICES__` and `__SUPPLEMENTAL__`) and applies
 * Chromium 148's rules (Electron 42.11.12) itself, giving the same PAC result string
 * (`PROXY host:port`, `SOCKS5 host:port`, `DIRECT`) to the shared resolver core. Sources, by the
 * Chromium file each rule comes from, are cited where the rule is implemented; the macOS CI
 * comparison (`.github/workflows/macos-system-proxy-compare.yml`) checks them against Electron.
 *
 * PAC and auto-discovery (28c): when the settings use either and the Chromium proxy helper is given
 * (chromium-proxy.ts, macOS releases carry its Electron), Chromium answers, exactly as for the desktop. Only
 * when the helper has no answer in time (starting, restarting, missing) does the Host fall back to what
 * follows, the static reading (28b).
 *
 * What the Host does not do, and reports as an unresolved path (the resolver core's `resolve_failed`:
 * direct, a warn, `unknown` in the path snapshot) instead of guessing:
 * - a PAC URL without an answer from the Chromium proxy helper;
 * - a proxy whose settings name a user (`HTTPUser`, `HTTPSUser`, `SOCKSUser`, macOS 15 and later): its
 *   password is in the keychain, which the Host never reads; a user name without its password is not
 *   used;
 * - output it cannot read with certainty.
 * Auto-discovery (WPAD) without a PAC URL: Chromium tries `http://wpad/wpad.dat` first and falls back to
 * the manual settings when that fails (`pac_file_decider.cc` `BuildPacSourcesFallbackList`,
 * `configured_proxy_resolution_service.cc` `OnInitProxyResolverComplete`); the Host uses the manual
 * settings directly and logs once that it did not try auto-discovery.
 *
 * Neither the scutil output nor any value in it is logged or kept: errors name a line number only,
 * and the parsed settings hold whether a user is set, never the user.
 */
import { execFile } from 'node:child_process';

import { createMakerLogger } from '../../desktop/src/main/maker-host/logger-adapter.ts';

const log = createMakerLogger('outbound-proxy');

/**
 * The Electron release whose Chromium these rules follow (Chromium 148.0.7778.280). A guard test
 * (hostDesktopSourceContracts.guard.test.ts) fails when apps/desktop/package.json moves to another
 * Electron: whoever upgrades updates this constant, which changes this file and so runs the macOS
 * system proxy comparison (.github/workflows/macos-system-proxy-compare.yml) on that pull request.
 */
export const CHROMIUM_RULES_ELECTRON_VERSION = '42.11.12';

/** The system's own scutil, by absolute path: never looked up on PATH, where a same-named program could stand in. */
const SCUTIL_PATH = '/usr/sbin/scutil';
const SCUTIL_TIMEOUT_MS = 1000;
const SCUTIL_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * How long one reading of the settings serves every request. With the resolver core's 30 s cache per
 * upstream, a change takes effect within 35 s (the desktop: 30 s; Chromium itself follows changes at once).
 */
const SYSTEM_PROXY_SETTINGS_TTL_MS = 5000;

/** One enabled manual proxy, as Chromium keeps it: canonical host (IPv6 in brackets) and port. */
interface ManualProxy {
  /** How Chromium's PAC result names it: the macOS HTTPS proxy is still an HTTP proxy (`proxy_chain_util_apple.cc`). */
  pacScheme: 'PROXY' | 'SOCKS5';
  host: string;
  port: number;
  /** The settings name a user for this proxy; the value itself is never kept. */
  namesUser: boolean;
}

type BypassRule =
  | { kind: 'simple-hostnames' }
  | { kind: 'subtract-implicit' }
  | { kind: 'hostname'; scheme: string; pattern: string; port: number }
  | { kind: 'ip-host'; scheme: string; host: string; port: number }
  | { kind: 'ip-block'; scheme: string; prefix: Uint8Array; bits: number };

interface MacSystemProxySettings {
  /** `ProxyAutoConfigEnable` with a URL string: Chromium runs that PAC script. */
  pacUrl: boolean;
  /** `ProxyAutoDiscoveryEnable` (WPAD). */
  autoDiscovery: boolean;
  http: ManualProxy | null;
  https: ManualProxy | null;
  socks: ManualProxy | null;
  bypass: BypassRule[];
}

/** A failure whose message is safe to log: it never carries output text or a setting's value. */
class SystemProxySettingsError extends Error {}

type ScValue = string | ScValue[] | Map<string, ScValue>;

/** SCPrint's text: `<dictionary> {`, `Key : value`, `Key : <array> {` / `<dictionary> {`, `N : item`, `}`. */
function parseScPrint(text: string): Map<string, ScValue> | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  // scutil's own text when SCDynamicStoreCopyProxies returns NULL (configd `do_showProxyConfiguration`).
  if (lines.length === 1 && lines[0] === 'No proxy configuration available') return null;
  const unreadable = (lineNumber: number) =>
    new SystemProxySettingsError(`unrecognised scutil --proxy output (line ${lineNumber})`);
  if (lines[0] !== '<dictionary> {') throw unreadable(1);
  const root = new Map<string, ScValue>();
  const open: Array<Map<string, ScValue> | ScValue[]> = [root];
  for (let index = 1; index < lines.length; index += 1) {
    const container = open.at(-1);
    if (!container) throw unreadable(index + 1);
    const line = lines[index]!;
    if (line === '}') {
      open.pop();
      continue;
    }
    const match = /^(\S+) :(?: (.*))?$/.exec(line);
    if (!match) throw unreadable(index + 1);
    const key = match[1]!;
    const raw = match[2] ?? '';
    const value: ScValue = raw === '<dictionary> {' ? new Map() : raw === '<array> {' ? [] : raw;
    if (container instanceof Map) {
      if (container.has(key)) throw unreadable(index + 1);
      container.set(key, value);
    } else {
      if (key !== String(container.length)) throw unreadable(index + 1);
      container.push(value);
    }
    if (typeof value !== 'string') open.push(value);
  }
  if (open.length !== 0) throw unreadable(lines.length);
  return root;
}

/** ASCII whitespace as base::TrimWhitespaceASCII trims it. */
function trimAscii(value: string): string {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}

/**
 * Chromium's IP literal parsing (`ip_address.h` `ParseIPLiteralToBytes`): with a colon, an IPv6 literal;
 * otherwise `url::IPv4AddressToNumber`, the URL standard's IPv4 parser (`url_canon_ip.h`), under which
 * `169.254` is 169.0.0.254 and `0x7f.1` is 127.0.0.1. Node's URL parser implements the same standard.
 */
function parseIpLiteral(literal: string): Uint8Array | null {
  if (literal.includes(':')) {
    if (!/^[0-9A-Fa-f:.]+$/.test(literal)) return null;
    try {
      return ipv6Bytes(new URL(`http://[${literal}]/`).hostname.slice(1, -1));
    } catch {
      return null;
    }
  }
  if (!/^[0-9A-Fa-fXx.]+$/.test(literal)) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${literal}/`).hostname;
  } catch {
    return null;
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  return parts ? Uint8Array.from(parts.slice(1).map(Number)) : null;
}

/** Bytes of a canonical (URL-serialised) IPv6 address. */
function ipv6Bytes(canonical: string): Uint8Array {
  const [head = '', tail] = canonical.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/** The form GURL gives an IP host: dotted IPv4, bracketed canonical IPv6 (`AddBracketsIfIPv6`). */
function ipHostString(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return new URL(`http://[${groups.join(':')}]/`).hostname;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  return bytes.length === 16 && bytes.subarray(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

/** `ip_address.cc` `IPAddressMatchesPrefix`, including the IPv4 / IPv6 mismatch mapping. */
function matchesPrefix(address: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  const mapped = (v4: Uint8Array) => Uint8Array.from([...Array<number>(10).fill(0), 0xff, 0xff, ...v4]);
  if (address.length !== prefix.length) {
    return address.length === 4 ? matchesPrefix(mapped(address), prefix, bits) : matchesPrefix(address, mapped(prefix), 96 + bits);
  }
  for (let bit = 0; bit < bits; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    if ((address[bit >> 3]! & mask) !== (prefix[bit >> 3]! & mask)) return false;
  }
  return true;
}

/** `url::ParsePort`: digits only, at most 65535; anything else is invalid (null). */
function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port <= 0xffff ? port : null;
}

/**
 * `url_util.cc` `ParseHostAndPort` over `url::ParseAuthority`: no user information; the port follows the
 * last colon that comes after any `]`; a bracketed host must be an IPv6 literal (brackets removed);
 * `host:` with an empty port is refused. Port -1: none given.
 */
function parseHostAndPort(input: string): { host: string; port: number } | null {
  if (!input || input.includes('@')) return null;
  // `url::ParseServerInfo`: the last `]` ends an IPv6 literal; a leading `[` without one runs to the end.
  const closing = input.lastIndexOf(']');
  const terminator = closing !== -1 ? closing : input.startsWith('[') ? input.length : -1;
  const colon = input.lastIndexOf(':');
  let host = input;
  let port = -1;
  if (colon > terminator) {
    host = input.slice(0, colon);
    const portText = input.slice(colon + 1);
    if (!portText) return null;
    const parsed = parsePort(portText);
    if (parsed === null) return null;
    port = parsed;
  }
  if (!host) return null;
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    if (!host.endsWith(']') || !inner.includes(':') || !parseIpLiteral(inner)) return null;
    host = inner;
  }
  return { host, port };
}

/**
 * One `ExceptionsList` item, as `ProxyHostMatchingRules::AddRuleFromString` parses it
 * (`proxy_host_matching_rules.cc` `ParseRule`, `scheme_host_port_matcher_rule.cc` `FromUntrimmedRawString`).
 * null: Chromium drops the rule.
 */
function parseBypassRule(rawUntrimmed: string): BypassRule | null {
  const trimmed = trimAscii(rawUntrimmed);
  if (asciiLower(trimmed) === '<local>') return { kind: 'simple-hostnames' };
  if (asciiLower(trimmed) === '<-loopback>') return { kind: 'subtract-implicit' };
  let raw = trimmed;
  let scheme = '';
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd !== -1) {
    scheme = raw.slice(0, schemeEnd);
    raw = raw.slice(schemeEnd + 3);
    if (!scheme) return null;
  }
  if (!raw) return null;
  if (raw.includes('/')) {
    // `ip_address.cc` `ParseCIDRBlock`: exactly one slash, an IP literal and a bit count within its size.
    // The scheme of an IP block rule is compared as written (not lower-cased), as in Chromium.
    const parts = raw.split('/').map(trimAscii);
    if (parts.length !== 2) return null;
    const prefix = parseIpLiteral(parts[0]!);
    if (!prefix || !/^\d+$/.test(parts[1]!)) return null;
    const bits = Number(parts[1]);
    if (bits > prefix.length * 8) return null;
    return { kind: 'ip-block', scheme, prefix, bits };
  }
  const hostAndPort = parseHostAndPort(raw);
  if (hostAndPort) {
    const ip = parseIpLiteral(hostAndPort.host);
    if (ip) return { kind: 'ip-host', scheme: asciiLower(scheme), host: ipHostString(ip), port: hostAndPort.port === -1 ? 0 : hostAndPort.port };
  }
  let port = -1;
  const colon = raw.lastIndexOf(':');
  if (colon !== -1) {
    const parsed = parsePort(raw.slice(colon + 1));
    if (parsed === null) return null;
    port = parsed;
    raw = raw.slice(0, colon);
  }
  const pattern = raw.startsWith('.') ? `*${raw}` : raw;
  return { kind: 'hostname', scheme: asciiLower(scheme), pattern: asciiLower(pattern), port };
}

/**
 * `base::MatchPattern` (`base/strings/pattern.cc`), ported step for step: `*` matches any run, `?` zero or
 * one character, `\` escapes either; each literal run is searched for at the first place it fits.
 */
function matchPattern(evaluated: string, pattern: string): boolean {
  const text = Array.from(evaluated);
  const pat = Array.from(pattern);
  let p = 0;
  let s = 0;
  do {
    let questionMarks = 0;
    let asterisk = false;
    while (p < pat.length && (pat[p] === '?' || pat[p] === '*')) {
      if (pat[p] === '?') questionMarks += 1;
      else asterisk = true;
      p += 1;
    }
    let maximumDistance = asterisk ? -1 : questionMarks;
    const patternStart = p;
    let stringStart = s;
    let escape = false;
    let found = false;
    for (;;) {
      if (p === pat.length) {
        if (s === text.length) {
          found = true;
          break;
        }
      } else {
        if (!escape && (pat[p] === '*' || pat[p] === '?')) {
          found = true;
          break;
        }
        if (!escape && pat[p] === '\\') {
          escape = true;
          p += 1;
          continue;
        }
        escape = false;
        if (s === text.length) return false;
        if (pat[p] === text[s]) {
          p += 1;
          s += 1;
          continue;
        }
      }
      if (maximumDistance === 0) return false;
      maximumDistance -= 1;
      p = patternStart;
      stringStart += 1;
      s = stringStart;
    }
    if (!found) return false;
  } while (p !== pat.length);
  return true;
}

interface UrlFacts {
  scheme: string;
  /** GURL `host()`: lower case, IPv6 in brackets. */
  host: string;
  hostNoBrackets: string;
  /** GURL `EffectiveIntPort()`: the port, or the scheme's default; -1 when there is none. */
  port: number;
  ip: Uint8Array | null;
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21 };

function urlFacts(url: URL): UrlFacts {
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname;
  const hostNoBrackets = host.startsWith('[') ? host.slice(1, -1) : host;
  const ip = host.startsWith('[') ? parseIpLiteral(hostNoBrackets) : /^\d+\.\d+\.\d+\.\d+$/.test(host) ? parseIpLiteral(host) : null;
  return { scheme, host, hostNoBrackets, port: url.port ? Number(url.port) : (DEFAULT_PORTS[scheme] ?? -1), ip };
}

/** `ProxyHostMatchingRules::MatchesImplicitRules` on macOS (Chromium 148: no 0.0.0.0 / [::] rule yet). */
function matchesImplicitRules(url: UrlFacts): boolean {
  // `url_util.cc` `HostStringIsLocalhost`: a loopback IP (127/8, ::1), or localhost, localhost., *.localhost.
  if (url.ip) {
    if (url.ip.length === 4 ? url.ip[0] === 127 : url.ip.subarray(0, 15).every(b => b === 0) && url.ip[15] === 1) return true;
  } else {
    const name = url.hostNoBrackets.endsWith('.') ? url.hostNoBrackets.slice(0, -1) : url.hostNoBrackets;
    if (asciiLower(name) === 'localhost' || name.endsWith('.localhost')) return true;
  }
  // `IsIPv4MappedLoopback`: [::ffff:127.x.x.x].
  if (url.host.startsWith('[::ffff') && url.ip && isIpv4Mapped(url.ip) && url.ip[12] === 127) return true;
  // `IsLinkLocalIP`: 169.254/16, [::ffff:169.254.0.0]/112, [fe80::]/10 (`IPAddress::IsLinkLocal`).
  if ((url.host.startsWith('169.254.') || url.host.startsWith('[')) && url.ip) {
    if (url.ip.length === 4) return url.ip[0] === 169 && url.ip[1] === 254;
    if (isIpv4Mapped(url.ip)) return url.ip[12] === 169 && url.ip[13] === 254;
    return url.ip[0] === 0xfe && (url.ip[1]! & 0xc0) === 0x80;
  }
  return false;
}

type RuleResult = 'include' | 'exclude' | 'no-match';

function evaluateRule(rule: BypassRule, url: UrlFacts): RuleResult {
  switch (rule.kind) {
    case 'simple-hostnames':
      return !url.host.includes('.') && !url.ip ? 'include' : 'no-match';
    case 'subtract-implicit':
      return matchesImplicitRules(url) ? 'exclude' : 'no-match';
    case 'hostname':
      if (rule.port !== -1 && url.port !== rule.port) return 'no-match';
      if (rule.scheme && url.scheme !== rule.scheme) return 'no-match';
      return matchPattern(url.host, rule.pattern) ? 'include' : 'no-match';
    case 'ip-host':
      if (rule.port !== 0 && url.port !== rule.port) return 'no-match';
      if (rule.scheme && url.scheme !== rule.scheme) return 'no-match';
      // `SchemeHostPortMatcherIPHostRule`: MatchPattern on two canonical IP strings, i.e. equality.
      return url.host === rule.host ? 'include' : 'no-match';
    case 'ip-block':
      if (!url.ip) return 'no-match';
      if (rule.scheme && url.scheme !== rule.scheme) return 'no-match';
      return matchesPrefix(url.ip, rule.prefix, rule.bits) ? 'include' : 'no-match';
  }
}

/**
 * `ProxyHostMatchingRules::Matches` (not reversed): later rules override earlier ones
 * (`scheme_host_port_matcher.cc` `Evaluate`), and without an explicit match the implicit rules apply.
 */
function bypasses(rules: readonly BypassRule[], url: UrlFacts): boolean {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const result = evaluateRule(rules[i]!, url);
    if (result === 'include') return true;
    if (result === 'exclude') return false;
  }
  return matchesImplicitRules(url);
}

/**
 * A proxy host as `ProxyServer::FromSchemeHostAndPort` takes it: trimmed, an IPv6 literal bracketed, then
 * canonicalised; empty, or failing canonicalisation, is invalid and the entry is ignored (null). A host with
 * characters whose canonicalisation in Chromium is not checked (white space, `/ \ ? # @ %`) is not guessed
 * at: the reading fails.
 */
function canonicalProxyHost(value: string): string | null {
  const host = trimAscii(value);
  if (!host) return null;
  const bracketed = !host.startsWith('[') && host.includes(':') ? `[${host}]` : host;
  if (/[\s/\\?#@%]/.test(bracketed)) throw new SystemProxySettingsError('unrecognised proxy host in the system proxy settings');
  try {
    return new URL(`http://${bracketed}/`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The settings Chromium reads from the dictionary (`proxy_config_service_mac.cc` `GetCurrentProxyConfig`),
 * from scutil's output. Keys outside this list (FTP, Gopher, RTSP, scoped services, inline PAC JavaScript,
 * which Chromium ignores too) are skipped.
 */
function parseScutilProxyOutput(text: string): MacSystemProxySettings {
  const dictionary = parseScPrint(text);
  const settings: MacSystemProxySettings = { pacUrl: false, autoDiscovery: false, http: null, https: null, socks: null, bypass: [] };
  if (!dictionary) return settings;
  // `GetValueFromDictionary<CFNumberRef>` / `<CFStringRef>` / `<CFArrayRef>` give null for a value of another
  // type, and Chromium then reads the key as missing. In the text a number is an integer, a string a scalar.
  const number = (key: string): number | undefined => {
    const value = dictionary.get(key);
    return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : undefined;
  };
  // `GetBoolFromDictionary`: a number, non-zero is true; missing is false.
  const flag = (key: string) => (number(key) ?? 0) !== 0;
  const stringValue = (key: string): string | undefined => {
    const value = dictionary.get(key);
    return typeof value === 'string' ? value : undefined;
  };
  // `ProxyDictionaryToProxyChain`: the host key missing makes the entry invalid (ignored); the port key
  // missing means the scheme's default (HTTP 80, SOCKS5 1080).
  const manual = (prefix: 'HTTP' | 'HTTPS' | 'SOCKS'): ManualProxy | null => {
    if (!flag(`${prefix}Enable`)) return null;
    const hostValue = stringValue(`${prefix}Proxy`);
    if (hostValue === undefined) return null;
    const pacScheme = prefix === 'SOCKS' ? 'SOCKS5' : 'PROXY';
    const port = number(`${prefix}Port`) ?? (pacScheme === 'SOCKS5' ? 1080 : 80);
    // Chromium narrows the integer to a 16-bit port; ports outside 1–65535 are not guessed at.
    if (port < 1 || port > 0xffff) throw new SystemProxySettingsError(`unexpected ${prefix}Port in the system proxy settings`);
    const host = canonicalProxyHost(hostValue);
    if (host === null) return null;
    const user = dictionary.get(`${prefix}User`);
    // A blank user names no one; any other value counts, whatever its type.
    return { pacScheme, host, port, namesUser: user !== undefined && !(typeof user === 'string' && trimAscii(user) === '') };
  };
  settings.autoDiscovery = flag('ProxyAutoDiscoveryEnable');
  // `set_pac_url(GURL(…))`, and `has_pac_url()` is the GURL being valid: otherwise the manual settings apply.
  settings.pacUrl = flag('ProxyAutoConfigEnable') && URL.canParse(trimAscii(stringValue('ProxyAutoConfigURLString') ?? ''));
  settings.http = manual('HTTP');
  settings.https = manual('HTTPS');
  settings.socks = manual('SOCKS');
  const exceptions = dictionary.get('ExceptionsList');
  if (Array.isArray(exceptions)) {
    for (const item of exceptions) {
      // Chromium skips an item that is not a string.
      if (typeof item !== 'string') continue;
      const rule = parseBypassRule(item);
      if (rule) settings.bypass.push(rule);
    }
  }
  // `PrependRuleToBypassSimpleHostnames`: `<local>` goes first, so every listed rule overrides it.
  if (flag('ExcludeSimpleHostnames')) settings.bypass.unshift({ kind: 'simple-hostnames' });
  return settings;
}

/**
 * The PAC result Chromium gives this URL under these settings (`proxy_config.cc` `ProxyRules::Apply`,
 * `MapUrlSchemeToProxyList`): no manual proxy → DIRECT; a bypass match → DIRECT; otherwise the proxy for
 * the URL's scheme, else the SOCKS proxy, else DIRECT. A manual result has exactly one entry and no DIRECT
 * after it. Throws (logged by the resolver core, which then goes direct) for what the Host does not do.
 */
function systemProxyResultFor(settings: MacSystemProxySettings, upstreamUrl: string): string {
  if (settings.pacUrl) {
    throw new SystemProxySettingsError('the system proxy settings use a proxy auto-config (PAC) URL, which the Host does not run yet');
  }
  const { http, https, socks } = settings;
  if (!http && !https && !socks) return 'DIRECT';
  const url = urlFacts(new URL(upstreamUrl));
  if (bypasses(settings.bypass, url)) return 'DIRECT';
  const proxy = url.scheme === 'http' ? (http ?? socks)
    : url.scheme === 'https' ? (https ?? socks)
      // `GetProxyListForWebSocketScheme`: SOCKS, then the HTTPS proxy, then the HTTP proxy.
      : url.scheme === 'ws' || url.scheme === 'wss' ? (socks ?? https ?? http)
        : socks;
  if (!proxy) return 'DIRECT';
  if (proxy.namesUser) {
    throw new SystemProxySettingsError('the system proxy for this request requires authentication; its password is in the keychain, which the Host does not read');
  }
  return `${proxy.pacScheme} ${proxy.host}:${proxy.port}`;
}

/** Reads the system proxy settings as scutil prints them. */
export type ReadSystemProxySettings = () => Promise<string>;

/** What the resolver core asks per upstream (its `getProxySession` port). */
export interface SystemProxySession {
  resolveProxy(url: string): Promise<string>;
}

/**
 * The Host's system proxy session: one reading of the settings serves every request for
 * SYSTEM_PROXY_SETTINGS_TTL_MS, and concurrent requests share one reading. A failed reading is not kept:
 * the resolver core already holds its unresolved verdict for 5 s per upstream.
 */
export function createMacSystemProxySession(readSettings: ReadSystemProxySettings, chromium?: SystemProxySession | null): SystemProxySession {
  let current: { settings: MacSystemProxySettings; expiresAt: number } | null = null;
  let reading: Promise<MacSystemProxySettings> | null = null;
  let reportedAutoDiscovery = false;

  function noteAutoDiscovery(settings: MacSystemProxySettings): void {
    const skipped = settings.autoDiscovery && !settings.pacUrl;
    if (skipped && !reportedAutoDiscovery) {
      log.warn('system proxy auto-discovery (WPAD) is not tried on the Host — using the manual proxy settings', {});
    }
    reportedAutoDiscovery = skipped;
  }

  function settingsNow(): Promise<MacSystemProxySettings> {
    if (current && current.expiresAt > Date.now()) return Promise.resolve(current.settings);
    reading ??= (async () => {
      try {
        const settings = parseScutilProxyOutput(await readSettings());
        current = { settings, expiresAt: Date.now() + SYSTEM_PROXY_SETTINGS_TTL_MS };
        return settings;
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  return {
    async resolveProxy(url) {
      const settings = await settingsNow();
      // On demand (28c): Chromium only for PAC and auto-discovery; static settings never start the helper.
      if (chromium && (settings.pacUrl || settings.autoDiscovery)) {
        try {
          return await chromium.resolveProxy(url);
        } catch {
          // No answer in time: the static reading below (28b), as before the helper.
        }
      }
      noteAutoDiscovery(settings);
      return systemProxyResultFor(settings, url);
    },
  };
}

/**
 * The production reader: `/usr/sbin/scutil --proxy`. `BYPASS_GLOBAL_PROXY` is removed from its
 * environment (it makes scutil skip the global proxies, configd `do_showProxyConfiguration`). Failures name
 * the exit code or signal only; stdout and stderr are never logged.
 */
export const readScutilProxyOutput: ReadSystemProxySettings = () => {
  const env = { ...process.env };
  delete env.BYPASS_GLOBAL_PROXY;
  return new Promise((resolve, reject) => {
    execFile(SCUTIL_PATH, ['--proxy'], {
      encoding: 'utf8', env, timeout: SCUTIL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: SCUTIL_MAX_OUTPUT_BYTES, windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const reason = (error as NodeJS.ErrnoException).code ?? error.signal ?? 'error';
        reject(new SystemProxySettingsError(`scutil --proxy failed (${String(reason)})`));
        return;
      }
      resolve(stdout);
    });
  });
};
