/**
 * SSH 部署专用的 Nginx 适配器，只由 root CLI 调用；中转进程本身不加载它。
 * 配置通过 Nginx 自己的 -T 发现，不假定发行版、安装目录或 sites-enabled 布局。
 * 只接管 /api/device-link/ 与自己的 ACME 验证，网站其余配置保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

const ROOT = '/etc/cindy-relay/nginx';
const STATE = `${ROOT}/state.json`;
const PENDING = `${ROOT}/pending.json`;
const HTTP = `${ROOT}/http.conf`;
const DATA = '/var/lib/cindy-relay';
const API = '/api/device-link/';
const CHALLENGE = '/.well-known/acme-challenge/';
const BEGIN = '# BEGIN Cindy relay';
const END = '# END Cindy relay';

interface Directive {
  file: string;
  name: string;
  args: string[];
  start: number;
  end: number;
  open?: number;
  children?: Directive[];
}

export interface NginxPatch {
  file: string;
  before: string;
  after: string;
}
export interface NginxPlan {
  patches: NginxPatch[];
  activatePatches: NginxPatch[];
  /** 没有 HTTP 站点时，申请证书之前就需要启用验证入口。 */
  httpServer: string | null;
  /** 新增的 HTTPS 虚拟站点；沿用目标原来的站点内容，仅替换监听地址与证书。 */
  tlsServer: string | null;
  existingCertificate: boolean;
}

/** 解析语法与位置，不用正则改写任意 Nginx 配置；引号、注释、变量与嵌套块分别处理。 */
function parse(file: string, source: string): Directive[] {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if ('{};'.includes(source[i])) {
      tokens.push({ value: source[i++], start, end: i });
      continue;
    }
    let value = '';
    let quote = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\' && i + 1 < source.length) {
        value += source[i + 1];
        i += 2;
        continue;
      }
      if (quote) {
        if (c === quote) quote = '';
        else value += c;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        const end = source.indexOf('}', i + 2);
        if (end < 0) throw new Error('Unclosed Nginx variable');
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (/\s/.test(c) || '{};#'.includes(c)) break;
      value += c;
      i++;
    }
    if (quote || i === start) throw new Error('Invalid Nginx token');
    tokens.push({ value, start, end: i });
  }
  let cursor = 0;
  function block(nested: boolean): Directive[] {
    const nodes: Directive[] = [];
    while (cursor < tokens.length && tokens[cursor].value !== '}') {
      const first = tokens[cursor++];
      const args: string[] = [];
      while (cursor < tokens.length && ![';', '{', '}'].includes(tokens[cursor].value)) args.push(tokens[cursor++].value);
      const delimiter = tokens[cursor++];
      if (!delimiter || delimiter.value === '}') throw new Error('Invalid Nginx directive');
      const node: Directive = {
        file,
        name: first.value,
        args,
        start: first.start,
        end: delimiter.end,
      };
      if (delimiter.value === '{') {
        node.open = delimiter.end;
        node.children = block(true);
        node.end = tokens[cursor - 1].end;
      }
      nodes.push(node);
    }
    if (nested && tokens[cursor++]?.value !== '}') throw new Error('Unclosed Nginx block');
    return nodes;
  }
  return block(false);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function included(pattern: string, files: Map<string, string>, main: string): string[] {
  const absolute = path.posix.resolve(path.posix.dirname(main), pattern);
  const match = new RegExp(
    `^${absolute
      .split('*')
      .map((part) => part.split('?').map(escapeRegex).join('.'))
      .join('.*')}$`,
  );
  return [...files.keys()].filter((file) => match.test(file));
}

function children(nodes: Directive[], files: Map<string, string>, main: string, seen: string[] = []): Directive[] {
  return nodes.flatMap((node) => {
    if (node.name !== 'include') return [node];
    return included(node.args[0] ?? '', files, main).flatMap((file) => {
      if (seen.includes(file)) throw new Error('Recursive Nginx include');
      return children(parse(file, files.get(file)!), files, main, [...seen, file]);
    });
  });
}

function listens(node: Directive, port: number, files: Map<string, string>, main: string): boolean {
  return serverListeners(node, files, main).some((d) => endpoint(d, port) !== null);
}

function serverListeners(node: Directive, files: Map<string, string>, main: string): Directive[] {
  const declared = children(node.children ?? [], files, main).filter((d) => d.name === 'listen');
  // 本适配器管理 root Nginx；没有 listen 的 server 原本就隐式监听 *:80。
  return declared.length ? declared : [{ ...node, name: 'listen', args: ['80'] }];
}

interface ListenGroup {
  endpoint: string;
  entries: Array<{ server: Directive; listen: Directive }>;
  defaultServer?: Directive;
}

function endpoint(listen: Directive, port: number): string | null {
  if (listen.name !== 'listen' || listen.args.includes('quic')) return null;
  const value = listen.args[0];
  if (value === String(port) || value === `*:${port}`) return `0.0.0.0:${port}`;
  if (port === 80) {
    if (value === '*') return '0.0.0.0:80';
    if (isIP(value) === 4) return `${value}:80`;
    if (value?.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6) return `${value}:80`;
  }
  if (value?.endsWith(`:${port}`) && (value.startsWith('[') || isIP(value.slice(0, value.lastIndexOf(':'))))) return value;
  return null;
}

function destinations(servers: Directive[], port: number, addresses: string[], files: Map<string, string>, main: string): ListenGroup[] {
  const groups = new Map<string, ListenGroup>();
  for (const server of servers)
    for (const listen of serverListeners(server, files, main)) {
      const socket = endpoint(listen, port);
      if (!socket) continue;
      const group = groups.get(socket) ?? { endpoint: socket, entries: [] };
      group.entries.push({ server, listen });
      if (!group.defaultServer || listen.args.some((a) => a === 'default_server' || a === 'default')) group.defaultServer = server;
      groups.set(socket, group);
    }
  const targets = new Map<string, ListenGroup>();
  for (const address of addresses) {
    const v6 = isIP(address) === 6;
    const specific = v6 ? `[${address}]:${port}` : `${address}:${port}`;
    const wildcard = v6 ? `[::]:${port}` : `0.0.0.0:${port}`;
    // 具体地址优先于通配监听；其他 IP 的站点和默认归属不能参与本次修改。
    // 公网地址可能经 NAT 映射；该端口尚无同族 socket 时用通配监听，不绑定公网 IP。
    // 已有其他具体地址时保留隔离，避免热重载新增通配 socket 与现有绑定冲突。
    const hasFamily = [...groups.keys()].some((socket) => socket.startsWith('[') === v6);
    const group = groups.get(specific) ?? groups.get(wildcard) ?? { endpoint: hasFamily ? specific : wildcard, entries: [] };
    targets.set(group.endpoint, group);
  }
  return [...targets.values()];
}

function selected(
  servers: Directive[],
  port: number,
  address: string,
  files: Map<string, string>,
  main: string,
  fallback?: Directive,
): Directive[] {
  const candidates = servers.filter((s) => listens(s, port, files, main));
  const names = (s: Directive) =>
    children(s.children ?? [], files, main)
      .filter((d) => d.name === 'server_name')
      .flatMap((d) => d.args);
  const exact = candidates.filter((s) => names(s).some((n) => n.toLowerCase() === address.toLowerCase()));
  if (exact.length) return exact;
  const wildcard = candidates.filter((s) =>
    names(s).some(
      (n) =>
        (n.startsWith('*.') && address.endsWith(n.slice(1))) ||
        (n.endsWith('.*') && address.startsWith(n.slice(0, -1))) ||
        (n.startsWith('.') && (address === n.slice(1) || address.endsWith(n))),
    ),
  );
  if (wildcard.length) {
    // Nginx 在通配符中选最长名字；不擅自猜测 PCRE 的匹配结果。
    const score = (s: Directive) => Math.max(...names(s).map((n) => n.length));
    const longest = Math.max(...wildcard.map(score));
    return wildcard.filter((s) => score(s) === longest);
  }
  if (candidates.some((s) => names(s).some((n) => n.startsWith('~')))) throw new Error('Nginx regex server names require an exact address');
  if (fallback) return [fallback];
  const defaults = candidates.filter((s) =>
    children(s.children ?? [], files, main).some(
      (d) => d.name === 'listen' && d.args.some((a) => a === 'default_server' || a === 'default'),
    ),
  );
  return defaults.length ? defaults : candidates.slice(0, 1);
}

function marked(text: string): string {
  return `${BEGIN}\n${text}\n${END}`;
}

function location(port: number, tls: boolean): string {
  return `location ^~ ${API} {
    proxy_pass ${tls ? 'https' : 'http'}://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cindy_relay_connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_intercept_errors off;
    error_page 502 =502 @cindy_relay_unavailable;
    recursive_error_pages off;
    client_max_body_size 0;
    auth_basic off;
    access_log off;
    error_log /dev/null;
}
location @cindy_relay_unavailable {
    access_log off;
    error_log /dev/null;
    recursive_error_pages off;
    return 502;
}`;
}

/** 从实际启用的文件生成最小补丁。before/after 也是卸载时的逆补丁，不还原整份旧文件覆盖用户后续修改。 */
export function planNginx(options: {
  main: string;
  files: Map<string, string>;
  address: string;
  port: number;
  challengePort: number;
  ipv6: boolean;
  /** 现有 HTTPS 已由宿主验证信任、地址和有效期时，直接沿用其证书管理。 */
  existingCertificate: boolean;
  certificateNames: (files: string[]) => string[];
  resolvedAddresses?: string[];
}): NginxPlan {
  const { main, files, address, port, challengePort } = options;
  if (!/^[a-zA-Z0-9.:-]+$/.test(address)) throw new Error('Invalid relay address');
  const http = parse(main, files.get(main) ?? '').find((d) => d.name === 'http' && d.children);
  if (!http) throw new Error('Nginx HTTP configuration not found');
  const servers = children(http.children!, files, main).filter((d) => d.name === 'server' && d.children);
  const addresses = options.resolvedAddresses ?? (isIP(address) ? [address] : ['0.0.0.0']);
  if (!addresses.length || addresses.some((ip) => !isIP(ip))) throw new Error('Relay address did not resolve to an IP');
  const httpSockets = destinations(servers, 80, addresses, files, main);
  const httpsSockets = destinations(servers, 443, addresses, files, main);
  const selectSocket = (group: ListenGroup, port: number, name = address) =>
    selected([...new Set(group.entries.map((e) => e.server))], port, name, files, main, group.defaultServer);
  const httpServers = [...new Set(httpSockets.flatMap((g) => selectSocket(g, 80)))];
  const httpsServers = [...new Set(httpsSockets.flatMap((g) => selectSocket(g, 443)))];
  const existingCertificate = options.existingCertificate && httpsServers.length > 0;
  const patches: NginxPatch[] = [];
  const activatePatches: NginxPatch[] = [];
  const insert = (node: Directive, body: string) => {
    const before = files.get(node.file)!.slice(node.start, node.open);
    patches.push({
      file: node.file,
      before,
      after: `${before}\n${marked(body)}\n`,
    });
  };
  insert(http, `include ${HTTP};`);

  // 用整个目标 server 作定位锚点，不能只替换常见的 “server {” 或相同的 return 语句。
  // 展开其直接 include 后仅修改该站点，避免改到多站点共用的片段。
  const versions = new Map<string, string>();
  const patchServer = (server: Directive, transform: (body: string) => string, deferred = false) => {
    const key = `${server.file}:${server.start}`;
    const original = files.get(server.file)!.slice(server.start, server.end);
    const before = versions.get(key) ?? original;
    const offset = before.indexOf('{') + 1;
    let body = before.slice(offset, -1);
    const direct = parse('body', body);
    for (const d of [...direct].reverse()) {
      if (d.name !== 'include') continue;
      const expanded = children([d], files, main)
        .map((n) => files.get(n.file)!.slice(n.start, n.end))
        .join('\n');
      body = body.slice(0, d.start) + expanded + body.slice(d.end);
    }
    const after = before.slice(0, offset) + transform(body) + '}';
    versions.set(key, after);
    (deferred ? activatePatches : patches).push({
      file: server.file,
      before,
      after,
    });
  };
  const routeApi = (body: string, tls: boolean): string => {
    body = body.replaceAll(`if ($uri !~ "^${CHALLENGE}")`, 'if ($uri !~ "^/(?:api/device-link/|[.]well-known/acme-challenge/)")');
    const directives = parse('body', body);
    if (directives.some((d) => d.name === 'location' && d.args.some((a) => a.startsWith(API) || a === '/api/device-link'))) {
      throw new Error('The existing site already serves the Cindy relay API path');
    }
    for (const d of [...directives].reverse()) {
      if (d.name === 'return')
        body = body.slice(0, d.start) + `if ($uri !~ "^${API}") { ${body.slice(d.start, d.end)} }` + body.slice(d.end);
    }
    return `${body}\n${marked(location(port, tls))}\n`;
  };
  let httpServer: string | null = null;
  let tlsServer: string | null = null;
  if (existingCertificate) {
    for (const server of httpsServers) patchServer(server, (body) => routeApi(body, false));
  } else {
    const challenge = `location ^~ ${CHALLENGE} {
    proxy_pass http://127.0.0.1:${challengePort};
    proxy_set_header Host $http_host;
    proxy_intercept_errors on;
    error_page 404 502 503 504 = @cindy_relay_existing_acme;
}`;
    for (const server of httpServers) {
      patchServer(server, (body) => {
        const directives = parse('body', body);
        const oldChallenges = directives.filter((d) => d.name === 'location' && d.args.includes(CHALLENGE));
        if (oldChallenges.length > 1) throw new Error('Ambiguous Nginx ACME locations');
        let fallback = 'try_files $uri =404;';
        const old = oldChallenges[0];
        if (old) {
          // 常见 Certbot / 宝塔 webroot 保留为 404 fallback，Cindy 不抢走其他客户端的验证文件。
          if (old.children?.some((d) => !['root', 'try_files', 'default_type', 'allow', 'deny', 'add_header'].includes(d.name))) {
            throw new Error('The existing ACME handler cannot be preserved automatically');
          }
          fallback = body.slice(old.open, old.end - 1);
          body = body.slice(0, old.start) + body.slice(old.end);
        }
        for (const d of [...parse('body', body)].reverse()) {
          if (d.name === 'return')
            body = body.slice(0, d.start) + `if ($uri !~ "^${CHALLENGE}") { ${body.slice(d.start, d.end)} }` + body.slice(d.end);
        }
        return `${body}\n${marked(`${challenge}\nlocation @cindy_relay_existing_acme { ${fallback} }`)}\n`;
      });
    }
    httpServer =
      httpSockets
        .filter((g) => !g.entries.length)
        .map(
          (g) =>
            `server {\nlisten ${g.endpoint};\nserver_name ${address};\n${challenge}\nlocation @cindy_relay_existing_acme { return 404; }\n}\n`,
        )
        .join('') || null;

    const cloneBody = (source: Directive | undefined, relay: boolean): string => {
      if (!source) return '';
      let body = files.get(source.file)!.slice(source.open, source.end - 1);
      if (source.children?.some((d) => d.name === 'include'))
        body = children(source.children, files, main)
          .map((d) => files.get(d.file)!.slice(d.start, d.end))
          .join('\n');
      for (const d of [...parse('clone', body)].reverse()) {
        if (
          ['listen', 'server_name', ...(relay ? ['ssl_certificate', 'ssl_certificate_key', 'ssl_reject_handshake'] : [])].includes(d.name)
        ) {
          body = body.slice(0, d.start) + body.slice(d.end);
        } else if (relay && d.name === 'return') {
          body = body.slice(0, d.start) + `if ($uri !~ "^${API}") { ${body.slice(d.start, d.end)} }` + body.slice(d.end);
        } else if (relay && d.name === 'location' && d.args.some((a) => a.startsWith(API)))
          throw new Error('The default site already serves the relay API path');
      }
      return body;
    };
    const certificateNames = (server: Directive) => {
      let certificates = children(server.children ?? [], files, main).filter((d) => d.name === 'ssl_certificate');
      if (!certificates.length) certificates = children(http.children!, files, main).filter((d) => d.name === 'ssl_certificate');
      return options.certificateNames(certificates.map((d) => path.posix.resolve(path.posix.dirname(main), d.args[0])));
    };

    // 使用独立虚拟站点承载新证书，不能替换多域名网站原有的证书。
    // 直接访问 IP 的 TLS 客户端常常不发 SNI。IP 证书必须用于默认握手，域名站点仍由 SNI 选择。
    // 原默认站点若只写 server_name _，从证书补出域名，保留已有 SNI 访问。
    const defaults = new Map(httpsSockets.filter((g) => g.defaultServer).map((g) => [g.endpoint, g.defaultServer!]));
    for (const server of new Set(defaults.values())) {
      patchServer(
        server,
        (body) => {
          // 托管 include 先登记目标 TLS 名字。保留原块的名字，保护它同时承载的其他 socket 和 HTTP。
          for (const d of [...parse('body', body)].reverse()) {
            const socket = endpoint(d, 443);
            if (!socket || defaults.get(socket) !== server) continue;
            let value = body.slice(d.start, d.end).replace(/\bdefault_server\b|\bdefault\b/g, '');
            if (!isIP(address)) value = value.slice(0, -1) + ' default_server;';
            body = body.slice(0, d.start) + value + body.slice(d.end);
          }
          return body;
        },
        true,
      );
    }
    for (const group of httpsSockets) {
      // 从地址原来会落到的默认站点继承正文，避免把原来通过 IP 打开的网站换成空页。
      const source = selectSocket(group, 443)[0] ?? httpServers[0];
      const body = cloneBody(source, true);
      const defaultFlag = isIP(address) ? ' default_server' : '';
      const protocol = ['http2', 'proxy_protocol'].filter((flag) => group.entries.some((e) => e.listen.args.includes(flag))).join(' ');
      const listen = `listen ${group.endpoint} ssl${defaultFlag}${protocol ? ` ${protocol}` : ''};\n`;
      if (isIP(address) && group.defaultServer) {
        const original = group.defaultServer;
        const declared = children(original.children ?? [], files, main)
          .filter((d) => d.name === 'server_name')
          .flatMap((d) => d.args);
        const names = certificateNames(original).filter(
          (name) => name !== address && !declared.includes(name) && selectSocket(group, 443, name).includes(original),
        );
        // 只在本次目标 socket 上补出原默认网站的 SNI 名字，不改它在其他 IP 上的名字。
        if (names.length)
          tlsServer =
            (tlsServer ?? '') +
            `server {\n${listen.replace(' default_server', '')}server_name ${names.join(' ')};\n${cloneBody(original, false)}\n}\n`;
      }
      tlsServer =
        (tlsServer ?? '') +
        `server {\n${listen}server_name ${address};\nssl_certificate __CINDY_CERT__/fullchain.pem;\nssl_certificate_key __CINDY_CERT__/key.pem;\n${body}\n${location(port, true)}\n}\n`;
    }
  }
  return { patches, activatePatches, httpServer, tlsServer, existingCertificate };
}

interface NginxInstance {
  binary: string;
  args: string[];
  pid: number;
}
interface Saved extends NginxPlan {
  address: string;
  port: number;
  challengePort: number;
  nginx: NginxInstance;
  certDir?: string;
}
interface Snapshot {
  files: Array<{ file: string; text: string | null; mode: number }>;
  previous: Saved | null;
  expected: Record<string, string>;
  accepted: Record<string, string[]>;
}

let transaction: { backup: Snapshot; persistent: boolean } | null = null;

function fingerprint(text: string | null): string {
  return text === null ? 'absent' : createHash('sha256').update(text).digest('hex');
}

function beginTransaction(backup: Snapshot, persistent: boolean): void {
  transaction = { backup, persistent };
  if (persistent) atomicWrite(PENDING, JSON.stringify(backup));
}

function read(file: string): string | null {
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Nginx configuration file is too large');
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function atomicWrite(file: string, text: string | null, mode = 0o600): void {
  if ((file === PENDING || file === STATE) && text !== null && Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error('Nginx deployment metadata is too large');
  if (text === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.cindy-${randomUUID()}.tmp`;
  try {
    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    fs.writeFileSync(temporary, text, {
      mode: stat ? stat.mode & 0o777 : mode,
      flag: 'wx',
    });
    if (stat) fs.chownSync(temporary, stat.uid, stat.gid);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function write(file: string, text: string | null, mode = 0o600): void {
  const backup = transaction?.backup;
  if (backup?.files.some((f) => f.file === file)) {
    const current = fingerprint(read(file));
    if (!backup.accepted[file]?.includes(current)) throw new Error('Nginx configuration changed during deployment; backup retained');
    const after = fingerprint(text);
    backup.accepted[file] = [...new Set([...backup.accepted[file], after])];
    backup.expected[file] = after;
    // 恢复凭证必须先于配置落盘；进程在任意一次 rename 前后退出均可识别自己的写入。
    if (transaction?.persistent) atomicWrite(PENDING, JSON.stringify(backup));
  }
  atomicWrite(file, text, mode);
}

function run(binary: string, args: string[]): string {
  // Nginx -T 包含用户配置，只在远端内存中处理，错误输出不上传到客户端或日志。
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Nginx configuration validation failed; previous configuration retained');
  }
}

function discover(): NginxInstance {
  const instances: NginxInstance[] = [];
  for (const entry of fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    let title: string;
    try {
      title = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!title.startsWith('nginx: master process ')) continue;
    const binary = fs.readlinkSync(`/proc/${entry}/exe`);
    const args: string[] = [];
    // -c/-p are paths; flags injected with -g are deliberately not executed as shell text.
    for (const flag of ['-c', '-p']) {
      const match = new RegExp(`(?:^|\\s)${flag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`).exec(title);
      if (match) args.push(flag, match[1] ?? match[2] ?? match[3]);
    }
    instances.push({ binary, args, pid: Number(entry) });
  }
  if (instances.length !== 1) throw new Error('Exactly one native Nginx master process is required');
  return instances[0];
}

function reload(nginx: NginxInstance): void {
  // 重启后 PID 会变化；每次重新定位同一安装，不能把旧 PID 当作 Nginx 的身份。
  const current = discover();
  if (current.binary !== nginx.binary || JSON.stringify(current.args) !== JSON.stringify(nginx.args))
    throw new Error('Nginx installation changed; previous configuration retained');
  run(current.binary, [...current.args, '-t']);
  process.kill(current.pid, 'SIGHUP');
}

function snapshot(files: string[], previous: Saved | null): Snapshot {
  const backup = {
    previous: structuredClone(previous),
    files: [...new Set(files)].map((file) => ({
      file,
      text: read(file),
      mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600,
    })),
    expected: {} as Record<string, string>,
    accepted: {} as Record<string, string[]>,
  };
  for (const f of backup.files) {
    const before = fingerprint(f.text);
    backup.expected[f.file] = before;
    backup.accepted[f.file] = [before];
  }
  return backup;
}

function restore(saved: Snapshot): void {
  // 申请证书可能持续数分钟。若期间管理员改过站点，保留备份并停止，不能覆盖这些新修改。
  for (const f of saved.files) {
    const accepted = transaction?.backup.accepted[f.file] ?? saved.accepted[f.file];
    if (!accepted?.includes(fingerprint(read(f.file)))) throw new Error('Nginx configuration changed during deployment; backup retained');
  }
  for (const f of saved.files) write(f.file, f.text, f.mode);
  write(STATE, saved.previous ? JSON.stringify(saved.previous) : null);
}

function assertPendingUnchanged(): void {
  const backup = JSON.parse(read(PENDING) ?? 'null') as Snapshot | null;
  for (const [file, expected] of Object.entries(backup?.expected ?? {})) {
    if (fingerprint(read(file)) !== expected) throw new Error('Nginx configuration changed during deployment; backup retained');
  }
}

function replacePatches(patches: NginxPatch[], reverse: boolean): void {
  for (const patch of reverse ? [...patches].reverse() : patches) {
    const before = reverse ? patch.after : patch.before;
    const after = reverse ? patch.before : patch.after;
    const text = read(patch.file);
    if (text === null || !text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) {
      throw new Error('Nginx configuration changed; refusing to overwrite other edits');
    }
    write(
      patch.file,
      text.replace(before, () => after),
      0o644,
    );
  }
}

function httpConfig(state: Saved, certDir?: string): string {
  const map = 'map $http_upgrade $cindy_relay_connection_upgrade { default upgrade; "" close; }\n';
  return map + (state.httpServer ?? '') + (certDir ? (state.tlsServer ?? '').replaceAll('__CINDY_CERT__', certDir) : '');
}

/** root-only CLI 生命周期。客户端不传配置文件路径、命令或证书内容。 */
export function manageNginx(
  action: string,
  options: {
    address?: string;
    ipv6?: boolean;
    existingCertificate?: boolean;
    resolvedAddresses?: string[];
  } = {},
): {
  existingCertificate?: boolean;
  port?: number;
  challengePort?: number;
} {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Nginx deployment requires Linux root');
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const lock = `${ROOT}/operation.lock`;
  try {
    if (fs.existsSync(lock)) {
      const pid = Number(read(lock));
      let active = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false;
        else throw error;
      }
      if (active) throw new Error('Nginx deployment is already running');
      fs.rmSync(lock);
    }
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Error('Nginx deployment is already running');
  }
  try {
    return manageLocked(action, options);
  } finally {
    transaction = null;
    fs.rmSync(lock, { force: true });
  }
}

function manageLocked(
  action: string,
  options: { address?: string; ipv6?: boolean; existingCertificate?: boolean; resolvedAddresses?: string[] },
): {
  existingCertificate?: boolean;
  port?: number;
  challengePort?: number;
} {
  // SSH 中断留下的事务在下一次部署自动恢复，不要求用户手动清理配置。
  if ((action === 'prepare' || action === 'remove') && read(PENDING)) manageLocked('rollback', {});
  if (action === 'renew' && read(PENDING)) return {};
  const saved = JSON.parse(read(STATE) ?? 'null') as Saved | null;
  if (action === 'prepare') {
    if (!options.address) throw new Error('Relay address required');
    const nginx = discover();
    const dump = run(nginx.binary, [...nginx.args, '-T']);
    const names = [...dump.matchAll(/^# configuration file (.+):\r?$/gm)].map((m) => m[1]);
    const main = names[0];
    if (!main) throw new Error('Nginx active configuration not found');
    const files = new Map(names.filter((f) => f !== HTTP).map((f) => [f, read(f)!]));
    // 升级时先在内存撤销上次补丁，再按当前站点重新生成；用户对其他配置的修改继续保留。
    if (saved)
      for (const p of [...saved.patches].reverse()) {
        const text = files.get(p.file);
        if (text === undefined || !text.includes(p.after)) throw new Error('Managed Nginx configuration changed');
        files.set(
          p.file,
          text.replace(p.after, () => p.before),
        );
      }
    const used = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((file) =>
      (read(file) ?? '').split('\n').flatMap((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[3] === '0A' ? [Number.parseInt(fields[1].split(':')[1], 16)] : [];
      }),
    );
    let port = saved?.port ?? 47820;
    let challengePort = saved?.challengePort ?? 47821;
    if (used.includes(port) || used.includes(challengePort)) {
      port = 47820;
      while (used.includes(port) && port < 47920) port++;
      challengePort = port + 1;
      while (used.includes(challengePort) && challengePort < 47921) challengePort++;
      if (port >= 47920 || challengePort >= 47921) throw new Error('No free relay loopback ports');
    }
    const existingCertificate = !!options.existingCertificate && (!saved || saved.existingCertificate || saved.address !== options.address);
    const plan = planNginx({
      main,
      files,
      address: options.address,
      port,
      challengePort,
      ipv6: !!options.ipv6,
      existingCertificate,
      resolvedAddresses: options.resolvedAddresses,
      certificateNames: (certificates) =>
        certificates.flatMap((file) => {
          if (file.includes('$')) throw new Error('Dynamic Nginx certificate paths cannot be preserved automatically');
          const cert = new X509Certificate(fs.readFileSync(file));
          const names = [...(cert.subjectAltName ?? '').matchAll(/(?:^|,\s*)DNS:([a-zA-Z0-9*_.-]+)(?=,|$)/g)].map((m) => m[1]);
          const cn = /^CN=([a-zA-Z0-9*_.-]+)$/m.exec(cert.subject)?.[1];
          return names.length ? names : cn ? [cn] : [];
        }),
    });
    // 尚无证书时不能提前改动现有 HTTPS 站点的证书引用；activate 才提交这些补丁。
    const snapshotFiles = [
      ...plan.patches.map((p) => p.file),
      ...plan.activatePatches.map((p) => p.file),
      ...(saved?.patches.map((p) => p.file) ?? []),
      HTTP,
      '/etc/systemd/system/cindy-relay.service',
    ];
    const backup = snapshot(snapshotFiles, saved);
    beginTransaction(backup, true);
    try {
      if (saved) replacePatches(saved.patches, true);
      replacePatches(plan.patches, false);
      const state: Saved = {
        ...plan,
        address: options.address,
        port,
        challengePort,
        nginx,
      };
      write(HTTP, httpConfig(state), 0o644);
      reload(nginx);
      write(STATE, JSON.stringify(state));
      return {
        existingCertificate: plan.existingCertificate,
        port,
        challengePort,
      };
    } catch (error) {
      restore(backup);
      reload(nginx);
      write(PENDING, null);
      throw error;
    }
  }
  if (action === 'rollback') {
    const pending = JSON.parse(read(PENDING) ?? 'null') as Snapshot | null;
    if (pending) {
      beginTransaction(pending, true);
      restore(pending);
      reload(pending.previous?.nginx ?? saved?.nginx ?? discover());
      write(PENDING, null);
    }
    return {};
  }
  if (!saved) return {};
  if (action === 'configure-service') {
    const pending = JSON.parse(read(PENDING) ?? 'null') as Snapshot | null;
    if (!pending) throw new Error('Nginx deployment transaction not found');
    assertPendingUnchanged();
    beginTransaction(pending, true);
    const unit = read('/etc/systemd/system/cindy-relay.service.new');
    if (!unit) throw new Error('Relay service unit not staged');
    write('/etc/systemd/system/cindy-relay.service', unit, 0o644);
    return {};
  }
  if (action === 'commit') {
    assertPendingUnchanged();
    write(PENDING, null);
    return {};
  }
  if (action === 'remove') {
    const backup = snapshot([...saved.patches.map((p) => p.file), HTTP], saved);
    beginTransaction(backup, true);
    try {
      replacePatches(saved.patches, true);
      write(HTTP, '');
      reload(saved.nginx);
    } catch (error) {
      restore(backup);
      reload(saved.nginx);
      throw error;
    }
    // ROOT 是此适配器创建的固定私有目录，绝不递归清理 Nginx 的站点或证书目录。
    fs.rmSync(ROOT, { recursive: true, force: true });
    return {};
  }
  if (action !== 'activate' && action !== 'renew') throw new Error('Unknown Nginx action');
  if (action === 'activate') assertPendingUnchanged();
  if (saved.existingCertificate) return {};
  const material = JSON.parse(read(`${DATA}/tls/material.json`) ?? '{}') as {
    cert: string;
    key: string;
  };
  const cert = new X509Certificate(material.cert);
  const matches = isIP(saved.address) ? cert.checkIP(saved.address) : cert.checkHost(saved.address);
  if (!matches || !cert.checkPrivateKey(createPrivateKey(material.key)) || Date.parse(cert.validTo) <= Date.now())
    throw new Error('Relay TLS material is invalid');
  const hash = createHash('sha256').update(material.cert).update(material.key).digest('hex');
  const certDir = `${ROOT}/tls/${hash}`;
  if (saved.certDir === certDir) return {};
  const backup = snapshot([...saved.patches.map((p) => p.file), ...saved.activatePatches.map((p) => p.file), HTTP], saved);
  const pending = action === 'activate' ? (JSON.parse(read(PENDING) ?? 'null') as Snapshot | null) : null;
  beginTransaction(pending ?? backup, !!pending);
  try {
    write(`${certDir}/fullchain.pem`, material.cert);
    write(`${certDir}/key.pem`, material.key);
    // 一代证书放在同一私有目录；配置一次性指向新一代，不能出现新 key 配旧 cert。
    if (!saved.certDir) {
      for (const patch of saved.activatePatches) {
        replacePatches([patch], false);
      }
      saved.patches.push(...saved.activatePatches);
      saved.activatePatches = [];
    }
    write(HTTP, httpConfig(saved, certDir), 0o644);
    reload(saved.nginx);
    saved.certDir = certDir;
    write(STATE, JSON.stringify(saved));
  } catch (error) {
    restore(backup);
    reload(saved.nginx);
    throw error;
  }
  return {};
}
