/**
 * 测试价值
 * - 生产入口：manageNginx 的 prepare/activate/renew/rollback/remove；观察实际写出的配置与恢复结果。
 * - 规则依据：2026-10-29 用户要求自动兼容 Nginx；不得停用已有网站、覆盖其他人的配置或破坏证书续期。
 * - 现有覆盖缺口：Desktop SSH fake 只覆盖调度，未执行远端配置事务。
 * - 最小输入：带默认网站的 80/443 配置、同一个块监听两端口/多个 IP、NAT 公网地址、校验失败及中途断开。
 * - tier：unit。文件系统/进程为内存适配，独立 CLI 的真实 Nginx 验证另在 Docker 执行。
 * - 实测耗时：单独运行本文件 0.398 秒（22 例，2026-10-29）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tests: 0,
  failTest: 0,
  signals: [] as number[],
  masterPid: '123',
  crashAt: '',
  crashBefore: false,
  crashed: false,
}));
const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
vi.mock('node:fs', () => ({
  default: {
    statSync: (file: string) => {
      if (h.crashed) throw new Error('simulated process termination');
      if (!h.files.has(file)) throw missing();
      return {
        size: Buffer.byteLength(h.files.get(file)!),
        mode: 0o100644,
        uid: 0,
        gid: 0,
      };
    },
    existsSync: (file: string) => h.files.has(file),
    readFileSync: (file: string) => {
      if (!h.files.has(file)) throw missing();
      return h.files.get(file)!;
    },
    realpathSync: (file: string) => file,
    writeFileSync: (file: string, value: string) => {
      if (h.crashed) throw new Error('simulated process termination');
      h.files.set(file, value);
    },
    renameSync: (from: string, to: string) => {
      if (h.crashed || (to === h.crashAt && h.crashBefore)) {
        h.crashed = true;
        throw new Error('simulated process termination');
      }
      h.files.set(to, h.files.get(from)!);
      h.files.delete(from);
      if (to === h.crashAt) {
        h.crashed = true;
        throw new Error('simulated process termination');
      }
    },
    chownSync: () => {},
    mkdirSync: () => {},
    rmSync: (file: string, options?: { recursive?: boolean }) => {
      if (h.crashed) throw new Error('simulated process termination');
      for (const key of h.files.keys()) if (key === file || (options?.recursive && key.startsWith(`${file}/`))) h.files.delete(key);
    },
    readdirSync: () => [h.masterPid],
    readlinkSync: () => '/usr/sbin/nginx',
  },
}));
vi.mock('node:child_process', () => ({
  execFileSync: (binary: string, args: string[]) => {
    if (binary === 'ss') return 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:47820 0.0.0.0:*';
    if (args.includes('-T'))
      return [...h.files]
        .filter(([file]) => file.startsWith('/etc/nginx/') || file.endsWith('/http.conf'))
        .map(([file, text]) => `# configuration file ${file}:\n${text}\n`)
        .join('\n');
    if (++h.tests === h.failTest) throw new Error('invalid configuration');
    return '';
  },
}));
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  createPrivateKey: (value: string) => value,
  X509Certificate: class {
    validTo = '2099-01-01';
    subjectAltName = 'DNS:website.example.test, DNS:www.example.test';
    subject = 'CN=website.example.test';
    constructor(private readonly cert: string) {}
    checkIP(address: string) {
      return address === '203.0.113.10';
    }
    checkHost(address: string) {
      return address === 'relay.example.test';
    }
    checkPrivateKey(key: string) {
      return this.cert === `test-cert-${key}`;
    }
  },
}));

import { manageNginx } from '../nginx';

const main = '/etc/nginx/nginx.conf';
const site = '/etc/nginx/conf.d/website.conf';
const root = '/etc/cindy-relay/nginx';
const originalMain = 'events {}\nhttp { include /etc/nginx/conf.d/*.conf; }';
const originalSite = `server { listen 80 default_server; server_name website.example.test;
  return 301 https://$host$request_uri;
  location ^~ /.well-known/acme-challenge/ { root /var/www/acme; try_files $uri =404; }
}
server { listen 443 ssl default_server; server_name website.example.test;
  ssl_certificate /website/cert.pem; ssl_certificate_key /website/key.pem;
  root /website/public; location / { try_files $uri $uri/ /index.html; }
}`;
function material(key: string) {
  h.files.set('/var/lib/cindy-relay/tls/material.json', JSON.stringify({ cert: `test-cert-${key}`, key }));
}
function prepare(existingCertificate = false) {
  return manageNginx('prepare', {
    address: '203.0.113.10',
    ipv6: true,
    existingCertificate,
  });
}

beforeEach(() => {
  h.files = new Map([
    [main, originalMain],
    [site, originalSite],
    ['/website/cert.pem', 'original-website-cert'],
    ['/site/cert.pem', 'original-website-cert'],
    ['/proc/net/tcp', '0: 00000000:0050 00000000:0000 0A\n1: 00000000:BACC 00000000:0000 0A\n'],
    ['/proc/123/cmdline', 'nginx: master process /usr/sbin/nginx -c /etc/nginx/nginx.conf'],
  ]);
  h.tests = 0;
  h.masterPid = '123';
  h.failTest = 0;
  h.signals = [];
  h.crashAt = '';
  h.crashed = false;
  h.crashBefore = false;
  const real = process;
  vi.stubGlobal('process', {
    ...real,
    platform: 'linux',
    getuid: () => 0,
    kill: (pid: number, signal: string | number) => {
      if (signal === 0) throw Object.assign(new Error('no process'), { code: 'ESRCH' });
      h.signals.push(pid);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it('preserves the original website and ACME webroot through certificate rotation, upgrade and removal', () => {
  const prepared = prepare();
  expect(prepared).toEqual({
    port: 47821,
    challengePort: 47822,
    existingCertificate: false,
  });
  expect(h.files.get(site)).toContain('location @cindy_relay_existing_acme {  root /var/www/acme; try_files $uri =404;');
  expect(h.files.get(site)).toContain('ssl_certificate /website/cert.pem;');
  material('key-one');
  manageNginx('activate');
  manageNginx('commit');
  const beforeRenewal = h.files.get(`${root}/http.conf`)!;
  expect(beforeRenewal).toContain('root /website/public; location / { try_files $uri $uri/ /index.html; }');
  expect(beforeRenewal).toContain('proxy_pass https://127.0.0.1:47821;');
  expect(beforeRenewal).toContain('server_name 203.0.113.10;');
  material('key-two');
  h.masterPid = '456';
  h.files.set('/proc/456/cmdline', h.files.get('/proc/123/cmdline')!);
  manageNginx('renew');
  expect(h.signals.at(-1)).toBe(456);
  expect(h.files.get(`${root}/http.conf`)).not.toBe(beforeRenewal);
  prepare();
  manageNginx('activate');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(main)).toBe(originalMain);
  expect(h.files.get(site)).toBe(originalSite);
  expect(h.files.has(`${root}/state.json`)).toBe(false);
});

it('keeps HTTP validation working when one server block listens on both 80 and 443', () => {
  h.files.set(
    site,
    'server { listen 80; listen 443 ssl; server_name 203.0.113.10; ssl_certificate /site/cert.pem; ssl_certificate_key /site/key.pem; return 301 https://www.example.test$request_uri; }',
  );
  const original = h.files.get(site);
  prepare();
  expect(h.files.get(site)).toContain('proxy_pass http://127.0.0.1:47822;');
  expect(h.files.get(site)).toContain('ssl_certificate /site/cert.pem;');
  material('key-one');
  manageNginx('activate');
  expect(h.files.get(site)).toContain('ssl_certificate /site/cert.pem;');
  expect(h.files.get(`${root}/http.conf`)).toContain('server_name website.example.test www.example.test;');
  expect(h.files.get(`${root}/http.conf`)).toContain('proxy_pass https://127.0.0.1:47821;');
  manageNginx('commit');
  material('key-two');
  manageNginx('renew');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(original);
});

it('uses the already trusted website certificate without replacing or requesting one', () => {
  prepare(true);
  expect(h.files.get(site)).toContain('proxy_pass http://127.0.0.1:47821;');
  expect(h.files.get(site)).toContain('ssl_certificate /website/cert.pem;');
  expect(h.files.get(site)).not.toContain('cindy_relay_existing_acme');
  manageNginx('activate');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(originalSite);
});

it('opens HTTP validation before requesting a certificate when Nginx only serves HTTPS', () => {
  const httpsOnly = originalSite.slice(originalSite.indexOf('server { listen 443'));
  h.files.set(site, httpsOnly);
  prepare();
  const beforeCertificate = h.files.get(`${root}/http.conf`)!;
  expect(beforeCertificate).toContain('listen 0.0.0.0:80;');
  expect(beforeCertificate).toContain('proxy_pass http://127.0.0.1:47822;');
  expect(beforeCertificate).not.toContain('listen 443');
  material('key-one');
  manageNginx('activate');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(httpsOnly);
});

it('restores the complete original configuration after failed validation and automatically recovers an interrupted deployment', () => {
  h.failTest = 1;
  expect(() => prepare()).toThrow('previous configuration retained');
  expect(h.files.get(main)).toBe(originalMain);
  expect(h.files.get(site)).toBe(originalSite);
  h.failTest = 0;
  prepare();
  // 模拟 SSH 中断；下一次 prepare 自行撤销未提交事务，不叠加重复配置。
  prepare();
  material('key-one');
  manageNginx('activate');
  manageNginx('rollback');
  expect(h.files.get(main)).toBe(originalMain);
  expect(h.files.get(site)).toBe(originalSite);
});

it('rejects a conflicting API route before changing the site', () => {
  const conflict = 'server { listen 443 ssl; server_name 203.0.113.10; location /api/device-link/ { return 418; } }';
  h.files.set(site, conflict);
  expect(() => prepare(true)).toThrow('already serves');
  expect(h.files.get(main)).toBe(originalMain);
  expect(h.files.get(site)).toBe(conflict);
});

it('retains the backup and administrator edits made while the certificate was being requested', () => {
  prepare();
  const edited = h.files.get(site)! + '\n# administrator edit\n';
  h.files.set(site, edited);
  material('key-one');
  expect(() => manageNginx('activate')).toThrow('configuration changed');
  expect(() => manageNginx('rollback')).toThrow('configuration changed');
  expect(h.files.get(site)).toBe(edited);
  expect(h.files.has(`${root}/pending.json`)).toBe(true);
});

it('restores a separate HTTPS file after activation fails and preserves other certificate aliases on retry', () => {
  const tlsFile = '/etc/nginx/conf.d/tls.conf';
  const originalTls =
    'server { listen 443 ssl; server_name relay.example.test www.example.test; ssl_certificate /site/cert.pem; ssl_certificate_key /site/key.pem; root /website/public; }';
  const originalHttp = 'server { listen 80; server_name relay.example.test; return 301 https://$host$request_uri; }';
  h.files.set(site, originalHttp);
  h.files.set(tlsFile, originalTls);
  const domain = () => manageNginx('prepare', { address: 'relay.example.test' });
  domain();
  material('key-one');
  h.failTest = h.tests + 1;
  expect(() => manageNginx('activate')).toThrow('previous configuration retained');
  expect(h.files.get(tlsFile)).toBe(originalTls);
  manageNginx('rollback');
  expect(h.files.get(site)).toBe(originalHttp);
  h.failTest = 0;
  domain();
  manageNginx('activate');
  expect(h.files.get(tlsFile)).toContain('server_name relay.example.test www.example.test;');
  expect(h.files.get(tlsFile)).toContain('ssl_certificate /site/cert.pem;');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(tlsFile)).toBe(originalTls);
});

// PR #7776：新增域名不能改变隐式默认网站，具体 IP 监听不能影响另一地址的站点。
it('keeps the implicit TLS default when adding a domain relay', () => {
  const implicit = originalSite.replace('443 ssl default_server', '443 ssl').replace('server_name website.example.test;', 'server_name _;');
  h.files.set(site, implicit);
  manageNginx('prepare', { address: 'relay.example.test', resolvedAddresses: ['203.0.113.10'] });
  material('key-one');
  manageNginx('activate');
  expect(h.files.get(site)).toContain('listen 443 ssl default_server;');
  expect(h.files.get(site)).toContain('ssl_certificate /website/cert.pem;');
  expect(h.files.get(`${root}/http.conf`)).toContain('listen 0.0.0.0:443 ssl;');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(implicit);
});

// PR #7776：Nginx 的省略 listen、只写地址两种语法仍占用 HTTP 80，不能新增站点抢走默认网页。
it.each([
  ['', '203.0.113.10'],
  ['listen 203.0.113.10;', '203.0.113.10'],
  ['listen [2001:db8::10];', '2001:db8::10'],
])('preserves the HTTP website with a default listen port (%s)', (listen, resolved) => {
  const implicit = originalSite.replace('listen 80 default_server;', listen);
  h.files.set(site, implicit);
  manageNginx('prepare', { address: 'relay.example.test', resolvedAddresses: [resolved] });
  expect(h.files.get(site)).toContain('proxy_pass http://127.0.0.1:47822;');
  expect(h.files.get(`${root}/http.conf`)).not.toContain('proxy_pass http://127.0.0.1:47822;');
  material('key-one');
  manageNginx('activate');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(implicit);
});

it('uses the matching specific socket and leaves other IP defaults and HTTP sites intact', () => {
  const unrelated =
    'server { listen 203.0.113.11:80; server_name _; return 200 other-http; }\nserver { listen 203.0.113.11:443 ssl; server_name a.example.test; }\nserver { listen 203.0.113.11:443 ssl default_server; server_name _; }';
  const targeted =
    'server { listen 203.0.113.10:443 ssl default_server; server_name website.example.test; ssl_certificate /website/cert.pem; ssl_certificate_key /website/key.pem; }';
  h.files.set(site, targeted + '\n' + unrelated);
  prepare();
  expect(h.files.get(site)).toContain(unrelated);
  material('key-one');
  manageNginx('activate');
  expect(h.files.get(site)).toContain(unrelated);
  expect(h.files.get(`${root}/http.conf`)).toContain('listen 203.0.113.10:443 ssl default_server;');
  expect(h.files.get(`${root}/http.conf`)).toContain('listen 203.0.113.10:80;');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(targeted + '\n' + unrelated);
});

// PR #7776：公网地址可能在 NAT 后；没有同族监听时不能把它当成本机网卡地址。
it.each(['203.0.113.10', 'relay.example.test'])('opens an unbound port on a wildcard for a NAT public address (%s)', (address) => {
  const httpOnly = originalSite.slice(0, originalSite.indexOf('server { listen 443'));
  h.files.set(site, httpOnly);
  manageNginx('prepare', { address, resolvedAddresses: ['203.0.113.10'] });
  material('key-one');
  manageNginx('activate');
  expect(h.files.get(`${root}/http.conf`)).toContain('listen 0.0.0.0:443 ssl');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(httpOnly);
});

it('keeps a shared server name on HTTP and unrelated TLS sockets when replacing only the target certificate', () => {
  const shared = 'server { listen 203.0.113.10:80; listen 203.0.113.10:443 ssl; listen 203.0.113.11:443 ssl; server_name relay.example.test; ssl_certificate /site/cert.pem; ssl_certificate_key /site/key.pem; root /website/public; }';
  const other = 'server { listen 203.0.113.11:443 ssl default_server; server_name _; }';
  h.files.set(site, other + '\n' + shared);
  manageNginx('prepare', { address: 'relay.example.test', resolvedAddresses: ['203.0.113.10'] });
  material('key-one');
  manageNginx('activate');
  expect(h.files.get(site)).toContain('server_name relay.example.test;');
  expect(h.files.get(site)).toContain(other);
  expect(h.files.get(`${root}/http.conf`)).toContain('listen 203.0.113.10:443 ssl;');
  expect(h.files.get(`${root}/http.conf`)).not.toContain('listen 203.0.113.11:443');
  manageNginx('commit');
  manageNginx('remove');
  expect(h.files.get(site)).toBe(other + '\n' + shared);
});

it.each([
  ['prepare', true],
  ['prepare', false],
  ['activate', false],
  ['remove', false],
] as const)(
  'recovers termination during %s (before rename: %s) without mistaking its own writes for administrator edits',
  (phase, before) => {
    if (phase !== 'prepare') {
      prepare();
      material('key-one');
    }
    if (phase === 'remove') {
      manageNginx('activate');
      manageNginx('commit');
    }
    h.crashAt = phase === 'prepare' ? site : `${root}/http.conf`;
    h.crashBefore = before;
    expect(() => (phase === 'prepare' ? prepare() : manageNginx(phase))).toThrow('simulated process termination');
    h.crashed = false;
    h.crashAt = '';
    prepare();
    material('key-one');
    manageNginx('activate');
    manageNginx('commit');
    manageNginx('remove');
    expect(h.files.get(site)).toBe(originalSite);
    expect(h.files.get(main)).toBe(originalMain);
  },
);

it('retains administrator changes made after a process terminates during prepare', () => {
  h.crashAt = site;
  expect(() => prepare()).toThrow('simulated process termination');
  h.crashed = false;
  h.crashAt = '';
  const edited = h.files.get(site)! + '\n# administrator change after interruption\n';
  h.files.set(site, edited);
  expect(() => prepare()).toThrow('configuration changed');
  expect(h.files.get(site)).toBe(edited);
  expect(h.files.has(`${root}/pending.json`)).toBe(true);
});

it('journals the staged service unit and restores the previous unit when deployment rolls back', () => {
  const unit = '/etc/systemd/system/cindy-relay.service';
  h.files.set(unit, '[Service]\nExecStart=previous-relay\n');
  prepare();
  h.files.set(`${unit}.new`, '[Service]\nExecStart=new-relay\n');
  manageNginx('configure-service');
  expect(h.files.get(unit)).toContain('ExecStart=new-relay');
  material('key-one');
  manageNginx('activate');
  manageNginx('rollback');
  expect(h.files.get(unit)).toBe('[Service]\nExecStart=previous-relay\n');
  expect(h.files.get(site)).toBe(originalSite);
});
