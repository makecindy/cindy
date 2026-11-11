/**
 * 上次成功获取的端点清单在本地的落盘缓存。
 *
 * 语义边界(重要,勿放宽):这份缓存只用于**远端清单传输失败**后的完整清单回退。
 * 正式 CDN 启动路径在自动重试预算用尽后可自动使用它;通用 resolver 也可保留由用户
 * 在阻断框上显式选择「用上次配置启动」的模式。解析/校验错误仍阻断,任何路径都不会
 * 用缓存掩盖远端配置事故。
 *
 * 因此:
 *  - 只在**不是本仓配置错**的失败上才允许作为出口(判定以 clientEndpointsService 的
 *    classifyManifestFailure 为准:传输层失败 / 5xx / 非配置 4xx);JSON / schema /
 *    非法值 / region 不匹配、永久性 HTTP 这类配置事故照旧硬阻断(给出口等于帮用户
 *    绕过一次真实的配置错);
 *  - 读回来的原文必须重新走同一套严格解析,磁盘内容不被信任;
 *  - 记录写入时的清单地址,升级或换区导致自举基址变化时缓存直接作废;
 *  - **端点主机必须落在写死的、按构建区域收紧的域内**(见 REGION_ENDPOINT_DOMAIN;
 *    只有 slack / telegram hook 这两个跨区共享服务例外)。
 *
 * 最后一条是安全边界,不是洁癖(review 抓到):这个文件位于 userData,可被其他进程
 * 写。严格解析只保证**语法**合法,不保证来源可信——攻击者写一份把 authApiBaseUrl
 * 指向自己 https 主机的缓存,再让清单 CDN 不可达,用户点「用上次配置启动」之后
 * authManager 就会把 access token 发到那台主机(凭证泄露)。真正的修法是服务端签名,
 * 但那是跨仓改动;在此之前用**编译期锚点**把爆炸半径收掉:允许的域是源码里写死的、
 * 且按构建区域收紧的(REGION_ENDPOINT_DOMAIN),任何 userData 写入都改不了它。
 *
 * 存储位置按 credentials-and-local-storage.md:Desktop 持久数据放
 * `app.getPath('userData')`。清单本身是 CDN 上公开可读的配置,不含任何凭证。
 * 路径由调用方注入(宿主决定目录),模块 import 时不产生任何文件系统副作用。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SupportedLocale } from '../shared/locale.js';

export const ENDPOINT_MANIFEST_CACHE_FILE_NAME = 'endpoint-manifest-cache.json';

/**
 * 缓存**文件**体积上限;超过即视为异常文件,不读也不写。
 *
 * 读写共用同一个常量,而且写路径校验的是**最终序列化结果**的字节数(review 抓到):
 * 上一版写路径只量 `manifestText`(≤64 KiB),落盘的却是把它当 JSON 字符串再包一层
 * (转义 + savedAt / sourceUrl + 缩进)。原文里全是需转义字符时,转义后体积会翻倍,
 * 于是存在一个区间——写检查放行、写成功了,读检查却按文件字节数拒掉,表现为
 * "明明写过缓存,下次离线按钮却点不亮"。两端量同一个东西就不会有这种自相矛盾。
 */
const MAX_CACHE_FILE_BYTES = 128 * 1024;

export interface CachedEndpointManifest {
  /** 写入时刻(ISO 8601)。 */
  savedAt: string;
  /** 写入时的清单地址(不含 cache-bust query),用于判定缓存是否仍然适用。 */
  sourceUrl: string;
  /** 清单原文,读回后仍需严格解析。 */
  manifestText: string;
}

function cacheFilePath(userDataDir: string, region?: 'cn' | 'global'): string {
  return path.join(
    userDataDir,
    region ? `endpoint-manifest-cache.${region}.json` : ENDPOINT_MANIFEST_CACHE_FILE_NAME,
  );
}

/**
 * 读一个**必须是常规文件**且不超过 maxBytes 的文本文件;不满足一律返回 null。
 *
 * 为什么不用 statSync + readFileSync(review 抓到):这个路径在 userData,别的进程能把它
 * 换成别的东西,而 `statSync` 会跟随 symlink、也不校验文件类型。symlink 到 `/dev/zero`
 * 会让 readFileSync 一直读到内存耗尽,FIFO 会让它**直接阻塞**——而这段代码跑在启动
 * 阻断路径上,阻塞等于启动卡死。
 *
 * 因此四道:
 *  1. `lstatSync` + `isFile()`:symlink / FIFO / 设备 / 目录全部在打开之前就拒掉
 *     (lstat 不跟随 symlink,对 symlink 而言 isFile() 为 false);
 *  2. **打开本身带 `O_NONBLOCK`**,这样即使 lstat 与 open 之间路径刚被换成 FIFO,
 *     `openSync` 也会立刻返回而不是等一个 writer(见下);
 *  3. 打开后用 `fstatSync` 复核类型与大小,并在两端 dev/ino 都可用时比对,**尽力**发现
 *     lstat 与 open 之间路径被替换的情况;
 *  4. 只读 fstat 报告的字节数,不给"打开后又变大"留口子。
 *
 * 第 2 条是 review 抓到的剩余缺口:第 1 道只关掉了"打开之前就是 FIFO"这一半,TOCTOU
 * 窗口内被换上 FIFO 时,不带 O_NONBLOCK 的 `open(O_RDONLY)` 在 POSIX 下会**阻塞**到有
 * writer 为止——而这段跑在启动阻断路径上,阻塞意味着连弹框都出不来。带上 O_NONBLOCK
 * 后 open 立即成功,随后第 3 道的 `isFile()` 把这个 fd 拒掉。常规文件不受 O_NONBLOCK
 * 影响,所以正常路径行为不变。Windows 上没有这个标志(常量缺失),退回 `'r'`——那边也
 * 没有 FIFO 的 open 阻塞语义。
 *
 * 第 3 条的措辞是刻意收紧的(review 指出过上一版说法过头):`fstatSync` 只能证明"我手上
 * 这个 fd 是常规文件、多大",并不能证明 `openSync` 没有跟随一个在窗口内刚被换上的
 * symlink;dev/ino 比对能查出"打开的不是 lstat 看到的那个 inode",但 Node 没有跨平台的
 * `O_NOFOLLOW` 等价物,所以这不是密闭保证,只是让实现与声明一致。Windows 上 ino
 * 可能为 0,那种情况跳过比对。
 */
function openReadOnlyNonBlocking(file: string): number {
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof nonBlock === 'number' && nonBlock !== 0) {
    return fs.openSync(file, fs.constants.O_RDONLY | nonBlock);
  }
  return fs.openSync(file, 'r');
}

function readRegularFileWithin(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const pre = fs.lstatSync(file);
    if (!pre.isFile() || pre.size > maxBytes) return null;
    fd = openReadOnlyNonBlocking(file);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    // best-effort:两端 ino 都拿得到才比对(Windows 上可能是 0)。
    if (pre.ino && stat.ino && (pre.ino !== stat.ino || pre.dev !== stat.dev)) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    const read = fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败无可挽回,也不该影响启动流程。
      }
    }
  }
}

/**
 * 读缓存。文件缺失、损坏、字段类型不对或体积异常都返回 null(缓存是可选辅助,
 * 任何异常都不该影响启动流程)。
 */
export function readEndpointManifestCache(
  userDataDir: string,
  region?: 'cn' | 'global',
): CachedEndpointManifest | null {
  const file = cacheFilePath(userDataDir, region);
  const raw = readRegularFileWithin(file, MAX_CACHE_FILE_BYTES);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { savedAt, sourceUrl, manifestText } = record;
  if (
    typeof savedAt !== 'string' ||
    typeof sourceUrl !== 'string' ||
    typeof manifestText !== 'string' ||
    !savedAt.trim() ||
    !sourceUrl.trim() ||
    !manifestText.trim() ||
    Number.isNaN(Date.parse(savedAt))
  ) {
    return null;
  }
  return { savedAt, sourceUrl, manifestText };
}

/**
 * 写缓存(先写临时文件再 rename,避免断电/崩溃留下半份 JSON)。
 * 返回 false = 写失败;调用方只记日志,不阻断启动。
 *
 * 临时文件必须是**唯一名字 + 独占创建**(review 抓到:上一版用固定的
 * `<target>.tmp`,而读路径的常规文件校验管不到写路径):
 *  - 别的进程在那个可预测路径上放一个 FIFO,`writeFileSync` 会**无限阻塞**。这段跑在
 *    清单解析**成功**之后、启动继续之前,阻塞等于启动卡死;
 *  - 放一个 symlink,`writeFileSync` 会跟随并截断链接目标——等于把它变成一个任意
 *    文件写入原语。
 * `'wx'`(O_WRONLY|O_CREAT|O_EXCL)对已存在的路径直接报错而不是打开它,POSIX 下
 * O_CREAT|O_EXCL 遇到 symlink 也必定失败;随机后缀则保证不会被"先占位"卡住。
 * 最终的 renameSync 不跟随 symlink,所以 target 被换成 symlink 也只是被替换掉。
 */
export function writeEndpointManifestCache(
  userDataDir: string,
  entry: CachedEndpointManifest,
  region?: 'cn' | 'global',
): boolean {
  // 量最终落盘的那份字节,并用同一份结果写入:读路径按文件字节数卡同一上限,
  // 两端量同一个东西才不会出现"写得进、读不回"。
  const payload = JSON.stringify(entry, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > MAX_CACHE_FILE_BYTES) return false;
  const target = cacheFilePath(userDataDir, region);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | null = null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    return true;
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败也要继续清理临时文件。
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败只会留下一个带随机后缀的临时文件,不影响下次写入。
    }
    return false;
  }
}

// Shared by desktop and mobile; keep these exports for existing desktop callers.
export {
  REGION_ENDPOINT_DOMAIN,
  CROSS_REGION_ENDPOINT_KEYS,
  findBootstrapHostOutsideTrustedDomains,
  findUntrustedCachedEndpoint,
  type CachedEndpointOriginPolicy,
} from '@cindy/maker-shared/client-endpoints';

/** 缓存时间戳 → 弹框里给用户看的本地时间;解析不了就原样回显。 */
export function formatCacheSavedAt(savedAt: string, locale: SupportedLocale): string {
  const timestamp = Date.parse(savedAt);
  if (Number.isNaN(timestamp)) return savedAt;
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch {
    return new Date(timestamp).toISOString();
  }
}
