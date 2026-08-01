/**
 * 端点清单离线缓存的读写与容错。
 *
 * 重点是「坏数据一律当没有缓存」:这份文件只用来点亮阻断框上的离线按钮,任何解析
 * 异常都必须降级为 null,绝不能反过来变成新的启动失败源。临时目录走 mkdtemp
 * (engineering-conventions §3.1),不碰真实 userData。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CROSS_REGION_ENDPOINT_KEYS,
  ENDPOINT_MANIFEST_CACHE_FILE_NAME,
  REGION_ENDPOINT_DOMAIN,
  findBootstrapHostOutsideTrustedDomains,
  findUntrustedCachedEndpoint,
  formatCacheSavedAt,
  readEndpointManifestCache,
  writeEndpointManifestCache,
} from '../endpointManifestCache';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-endpoint-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ENTRY = {
  savedAt: '2026-07-29T06:22:00.000Z',
  sourceUrl: 'https://cdn.example.com/endpoint.json',
  manifestText: JSON.stringify({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.com' }),
};

function cacheFile(): string {
  return path.join(dir, ENDPOINT_MANIFEST_CACHE_FILE_NAME);
}

// Windows 上创建 symlink 需要管理员或开发者模式;拿不到权限时(EPERM)跳过相关
// 用例,与下面 mkfifo 不可用时的处理一致。探测一次,别让每个用例各炸一遍。
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-symlink-probe-'));
  try {
    fs.symlinkSync(path.join(probeDir, 'target'), path.join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe('endpointManifestCache', () => {
  it('写入后可原样读回', () => {
    expect(writeEndpointManifestCache(dir, ENTRY)).toBe(true);
    expect(readEndpointManifestCache(dir)).toEqual(ENTRY);
  });

  it('目录不存在时自动创建', () => {
    const nested = path.join(dir, 'a', 'b');
    expect(writeEndpointManifestCache(nested, ENTRY)).toBe(true);
    expect(readEndpointManifestCache(nested)).toEqual(ENTRY);
  });

  it('写入不留下临时文件', () => {
    writeEndpointManifestCache(dir, ENTRY);
    expect(fs.existsSync(`${cacheFile()}.tmp`)).toBe(false);
  });

  it('文件缺失返回 null', () => {
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it.each([
    ['非 JSON', 'not json'],
    ['JSON 数组', '[]'],
    ['JSON 标量', '42'],
    ['缺 manifestText', JSON.stringify({ savedAt: ENTRY.savedAt, sourceUrl: ENTRY.sourceUrl })],
    ['字段类型不对', JSON.stringify({ ...ENTRY, sourceUrl: 123 })],
    ['savedAt 不可解析', JSON.stringify({ ...ENTRY, savedAt: 'whenever' })],
    ['字段空白', JSON.stringify({ ...ENTRY, manifestText: '   ' })],
  ])('%s → null(坏数据当没有缓存)', (_label, raw) => {
    fs.writeFileSync(cacheFile(), raw, 'utf8');
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('文件字节数超上限时读前就拒绝(不把大文件读进内存)', () => {
    fs.writeFileSync(cacheFile(), 'x'.repeat(128 * 1024 + 1), 'utf8');
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('多字节 UTF-8 内容按字节而非字符数判断', () => {
    // 每个汉字 3 字节:字符数远小于上限,字节数刚好越界。用 string.length 判断会放行。
    const cjk = '配'.repeat((128 * 1024) / 3 + 10);
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(128 * 1024);
    expect(cjk.length).toBeLessThan(128 * 1024);
    fs.writeFileSync(cacheFile(), cjk, 'utf8');
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('最终落盘 JSON 超上限时拒绝写入', () => {
    const huge = { ...ENTRY, manifestText: 'x'.repeat(128 * 1024 + 1) };
    expect(writeEndpointManifestCache(dir, huge)).toBe(false);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('写检查量的是序列化后的字节:全转义字符不会"写得进、读不回"', () => {
    // manifestText 本身 64KiB(旧实现的上限之内),但每个 `"` 被 JSON 转义成 `\\"`,
    // 落盘 payload 翻倍越过 128KiB。旧实现会写成功、读路径再按文件字节数拒掉。
    const quoted = { ...ENTRY, manifestText: '"'.repeat(64 * 1024) };
    expect(Buffer.byteLength(quoted.manifestText, 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(quoted, null, 2), 'utf8')).toBeGreaterThan(128 * 1024);

    expect(writeEndpointManifestCache(dir, quoted)).toBe(false);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('写得进的一定读得回(读写共用同一上限)', () => {
    // 贴着上限:序列化后不超过 128KiB 就必须写成功且原样读回。
    let text = 'y'.repeat(100 * 1024);
    while (
      Buffer.byteLength(JSON.stringify({ ...ENTRY, manifestText: text }, null, 2), 'utf8') >
      128 * 1024
    ) {
      text = text.slice(0, -1024);
    }
    const big = { ...ENTRY, manifestText: text };
    expect(writeEndpointManifestCache(dir, big)).toBe(true);
    expect(readEndpointManifestCache(dir)).toEqual(big);
  });

  it('formatCacheSavedAt 解析不了就原样回显', () => {
    expect(formatCacheSavedAt('not-a-date', 'zh-CN')).toBe('not-a-date');
    expect(formatCacheSavedAt(ENTRY.savedAt, 'zh-CN')).not.toBe('');
  });
});

describe('缓存端点的受信任域约束(安全边界)', () => {
  // 生产实际取值:两份自举基址都由构建脚本注入,userData 写入改不了。
  const GLOBAL_BASE = 'https://hotfix.cindy.app/cindy';
  const CN_BASE = 'https://hotfix.cindy.com.cn/cindy';
  const TRUSTED = Object.values(REGION_ENDPOINT_DOMAIN);
  /** CN 构建的策略:非跨区端点锁 cindy.com.cn,slack/telegram/x hook 才允许 cindy.app。 */
  const CN_POLICY = {
    regionDomain: REGION_ENDPOINT_DOMAIN.cn,
    crossRegionDomain: REGION_ENDPOINT_DOMAIN.global,
  };
  const GLOBAL_POLICY = {
    regionDomain: REGION_ENDPOINT_DOMAIN.global,
    crossRegionDomain: REGION_ENDPOINT_DOMAIN.global,
  };

  it('区域域名是显式写死的(不从基址推导)', () => {
    // 上一版从自举基址「去掉最左一段」推导,在多段公共后缀上会**放宽**信任:
    // https://example.co.uk → co.uk,于是任何 attacker.co.uk 都成了可信。
    expect([...TRUSTED].sort()).toEqual(['cindy.app', 'cindy.com.cn']);
    expect(REGION_ENDPOINT_DOMAIN.cn).toBe('cindy.com.cn');
    expect(REGION_ENDPOINT_DOMAIN.global).toBe('cindy.app');
  });

  it('跨区例外只有 slack / telegram / x hook 三个 key', () => {
    // 每加一个 key 就等于允许该端点跨区,而跨区 token 误发正是要防的事。
    expect([...CROSS_REGION_ENDPOINT_KEYS].sort()).toEqual([
      'slackHookWsUrl',
      'telegramHookWsUrl',
      'xHookWsUrl',
    ]);
  });

  it('CN 构建拒绝换成 Global 真实服务的伪造缓存(跨区 token 误发)', () => {
    // 线上两份清单都没有 region 字段、region 本身也是清单里未认证的数据,所以
    // 「两域并集」会让这份缓存通过:sourceUrl 匹配 CN、主机是 Global 的**真实**服务。
    expect(
      findUntrustedCachedEndpoint(
        {
          authApiBaseUrl: 'https://auth.cindy.app',
          websiteUrl: 'https://cindy.com.cn',
        },
        CN_POLICY,
      ),
    ).toBe('authApiBaseUrl');
  });

  it.each([
    'deviceLinkApiBaseUrl',
    'oauthBrokerApiBaseUrl',
    'modelAccessApiBaseUrl',
    'voiceApiBaseUrl',
    'authDesktopCallbackUrl',
  ])('CN 构建下 %s 也不允许落在 Global 域', (key) => {
    expect(findUntrustedCachedEndpoint({ [key]: 'https://x.cindy.app' }, CN_POLICY)).toBe(key);
  });

  it('Global 构建下本区端点必须是 cindy.app,不接受 CN 域', () => {
    expect(
      findUntrustedCachedEndpoint({ authApiBaseUrl: 'https://auth.cindy.com.cn' }, GLOBAL_POLICY),
    ).toBe('authApiBaseUrl');
  });

  it('自检:两份自举基址都落在受信任域内', () => {
    expect(findBootstrapHostOutsideTrustedDomains([GLOBAL_BASE, CN_BASE], TRUSTED)).toBeNull();
  });

  it.each([
    ['apex 在多段公共后缀下', 'https://example.co.uk', 'example.co.uk'],
    ['完全无关的域', 'https://cdn.attacker.net', 'cdn.attacker.net'],
    ['非 URL', 'not a url', 'not a url'],
  ])('自检报出越界的自举主机:%s', (_label, baseUrl, expected) => {
    expect(findBootstrapHostOutsideTrustedDomains([baseUrl], TRUSTED)).toBe(expected);
  });

  it('自检忽略空基址(某些构建只有本区基址)', () => {
    expect(findBootstrapHostOutsideTrustedDomains([GLOBAL_BASE, '', '   '], TRUSTED)).toBeNull();
  });

  it('仓内 CN 清单的真实端点全部合规(hook 走跨区例外,其余锁本区)', () => {
    expect(
      findUntrustedCachedEndpoint(
        {
          authApiBaseUrl: 'https://auth.cindy.com.cn',
          slackHookWsUrl: 'wss://slack-hook.cindy.app',
          telegramHookWsUrl: 'wss://telegram-hook.cindy.app',
          // CN 清单按 Telegram 同款单部署模式放量 X 时,离线缓存回退必须仍受信
          // (PR #1230 review:漏登记会让 CN 用户断网时失去缓存启动出口)。
          xHookWsUrl: 'wss://x-hook.cindy.app',
          websiteUrl: 'https://cindy.com.cn',
          cdnBaseUrl: 'https://hotfix.cindy.com.cn/cindy',
          authDesktopCallbackUrl: 'https://auth.cindy.com.cn/api/auth/desktop/callback',
        },
        CN_POLICY,
      ),
    ).toBeNull();
  });

  it('仓内 Global 清单的真实端点全部合规', () => {
    expect(
      findUntrustedCachedEndpoint(
        {
          authApiBaseUrl: 'https://auth.cindy.app',
          slackHookWsUrl: 'wss://slack-hook.cindy.app',
          websiteUrl: 'https://cindy.app',
          cdnBaseUrl: 'https://hotfix.cindy.app/cindy',
        },
        GLOBAL_POLICY,
      ),
    ).toBeNull();
  });

  it.each([
    ['攻击者自选主机', 'https://evil.example.com'],
    ['受信任域作为子串但不是后缀', 'https://cindy.app.evil.com'],
    ['受信任域拼在主机名里', 'https://notcindy.app'],
    ['末尾多一段', 'https://auth.cindy.app.attacker.net'],
  ])('%s 被拒(返回越界的 key)', (_label, hostile) => {
    expect(
      findUntrustedCachedEndpoint(
        { authApiBaseUrl: hostile, websiteUrl: 'https://cindy.app' },
        GLOBAL_POLICY,
      ),
    ).toBe('authApiBaseUrl');
  });

  it('空值端点跳过检查(缺失端点本就归一成空串)', () => {
    expect(
      findUntrustedCachedEndpoint({ authApiBaseUrl: '', heartbeatUrl: '' }, GLOBAL_POLICY),
    ).toBeNull();
  });

  it('策略缺域名时一律拒绝(fail closed,不是放行)', () => {
    expect(
      findUntrustedCachedEndpoint(
        { authApiBaseUrl: 'https://auth.cindy.app' },
        { regionDomain: '', crossRegionDomain: '' },
      ),
    ).toBe('origin-policy-unavailable');
  });
});

describe('缓存读取只接受常规文件(阻断路径不能被挂住)', () => {
  // skipIf: 无 symlink 权限时报告为 skipped 而不是假 passed
  it.skipIf(!canSymlink)('symlink 指向合法缓存也拒绝(statSync 会跟随,lstatSync 不会)', () => {
    const real = path.join(dir, 'real-cache.json');
    fs.writeFileSync(real, JSON.stringify(ENTRY), 'utf8');
    fs.symlinkSync(real, cacheFile());
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('目录占位时拒绝', () => {
    fs.mkdirSync(cacheFile());
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('FIFO 时拒绝且不阻塞', () => {
    // readFileSync 打开 FIFO 会**阻塞**——这段跑在启动阻断路径上,阻塞等于启动卡死。
    const mkfifo = spawnSync('mkfifo', [cacheFile()]);
    if (mkfifo.status !== 0) return; // 平台没有 mkfifo(Windows)时跳过
    const startedAt = Date.now();
    expect(readEndpointManifestCache(dir)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('lstat 通过之后路径才变成 FIFO(TOCTOU 窗口)时,open 也不阻塞', () => {
    // review 抓到:lstat 那道只挡住"打开前就是 FIFO";窗口内被换上 FIFO 时,
    // 不带 O_NONBLOCK 的 open(O_RDONLY) 在 POSIX 下会等到有 writer 为止 —— 而这段
    // 跑在启动阻断路径上,等于连弹框都出不来。这里把 lstat 结果伪造成常规文件来
    // 精确复现那个窗口:实现必须靠 O_NONBLOCK + fstat 复核活着回来。
    const mkfifo = spawnSync('mkfifo', [cacheFile()]);
    if (mkfifo.status !== 0) return; // 平台没有 mkfifo(Windows)时跳过
    const spy = vi
      .spyOn(fs, 'lstatSync')
      .mockReturnValue({ isFile: () => true, size: 16, ino: 0, dev: 0 } as unknown as fs.Stats);
    try {
      const startedAt = Date.now();
      expect(readEndpointManifestCache(dir)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('缓存写入的临时文件必须唯一且独占创建', () => {
  it('临时文件名带 pid 与随机后缀,不是可预测的 <target>.tmp', () => {
    expect(writeEndpointManifestCache(dir, ENTRY)).toBe(true);
    // 固定名字会被别的进程先占位(FIFO → writeFileSync 无限阻塞;symlink → 跟随并截断)。
    expect(fs.existsSync(`${cacheFile()}.tmp`)).toBe(false);
    // 成功路径不留任何临时文件。
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('固定 .tmp 路径被 FIFO 占位也不影响写入(不再走那个路径)', () => {
    const mkfifo = spawnSync('mkfifo', [`${cacheFile()}.tmp`]);
    if (mkfifo.status !== 0) return; // 平台没有 mkfifo(Windows)时跳过
    const startedAt = Date.now();
    expect(writeEndpointManifestCache(dir, ENTRY)).toBe(true);
    // 旧实现会在这里无限阻塞;这段跑在清单解析成功之后、启动继续之前。
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(readEndpointManifestCache(dir)).toEqual(ENTRY);
  });

  // skipIf: 无 symlink 权限时报告为 skipped 而不是假 passed
  it.skipIf(!canSymlink)('target 被换成 symlink 时 rename 替换掉它本身,不写穿到链接目标', () => {
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'untouched', 'utf8');
    fs.symlinkSync(outside, cacheFile());

    expect(writeEndpointManifestCache(dir, ENTRY)).toBe(true);
    // 链接目标内容不变 = 没有被当成任意文件写入原语。
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    // cacheFile 现在是常规文件(symlink 已被 rename 替换),读回正常。
    expect(fs.lstatSync(cacheFile()).isSymbolicLink()).toBe(false);
    expect(readEndpointManifestCache(dir)).toEqual(ENTRY);
  });
});
