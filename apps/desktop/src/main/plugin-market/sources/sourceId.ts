/**
 * 自定义市场来源的不透明标识（sourceId，契约第 2 版 V2.2）。只用于核实「装的是哪个来源」，不展示。
 *
 * sourceId = base64url(HMAC-SHA256(K, input)) 的前 16 字节，input 是带域名与版本的 JSON 数组（数组元素
 * 有界，没有拼接歧义）：
 * - 本地文件夹：["cindy.plugin-market.source-id", 2, "local", marketSourceKey]
 * - Git：["cindy.plugin-market.source-id", 2, "git", marketSourceKey, scheme, user, host, port, path]，后五项是
 *   **实际取包地址**按白名单取出的部件（pluginMarketFetchAddress）：`user` 只是 ssh / scp 的登录用户（同主机
 *   同路径可随用户解析到不同仓库），https 等协议的 userinfo 是凭证、不读取；不含密码、令牌、查询串、片段。
 *   登录用户只进这里的 HMAC 输入，不进取包记录、展示、回执或日志。
 *   Git 来源的 sourceId 在取包时算好，记在该缓存版本的取包记录里（见 fetchIdentity.ts）。
 * 于是不同本地目录、同主机不同端口、不同协议写法、不同稀疏路径、配置相同但被 insteadOf 改写到不同地址，
 * 都得到不同的标识。用 HMAC 而不是裸哈希：本地路径与仓库地址熵低，裸哈希可被穷举反推。
 *
 * 密钥 K：每个数据所有者一把，32 字节随机，按「代」存放：`owners/<账号>/plugin-market/source-id/v<N>/key`，用最高的
 * 那一代。
 * - 读写都是异步的（`prepare()`）：市场列表、详情、远程目录这些 IPC 读路径会用到它，不能阻塞主线程。
 *   同步的计算函数只用已经读好的密钥，没读好就返回 null（身份缺省），从不回退到同步读盘。
 * - 只发布一把：新的一代先在同目录的暂存子目录里写好完整的 key，再把整个子目录 rename 成 `v<N>`。目标已存在
 *   （非空目录）时 rename 失败，所以同一代只有一个写入者胜出；并发的其它调用方（同进程或另一个 Cindy 进程）
 *   随后重读，拿到的都是胜出的那一把。不依赖硬链接，目录 rename 在各平台与常见文件系统上都可用。
 * - 首次创建写 v1；最高一代的 key 缺失或损坏时写下一代（不就地覆盖），损坏的那一代留作现场。目录或文件在但
 *   读不到（权限、锁）时不重建，本次没有 sourceId。
 * - 密钥标识 keyId：由 K 派生的短标识（HMAC(K, 域名) 的前 9 字节），随取包记录与安装绑定一起记下。比较两个
 *   sourceId 之前先比 keyId：不同即「无法核实」，不是「来源不同」。密钥被重建后，旧记录与旧绑定一律当作无法
 *   核实，不会被误判为换源（因此不会暂停更新或隔离插件数据）；下一次取包或安装后按新密钥重新记下。
 * - 重建后旧标识对不上，控制端按「未确认」处理，不影响已装插件、批准状态或账本。Windows 上 POSIX 权限位
 *   不生效，与其它本机状态文件一样依赖用户 profile 目录的 ACL。
 * - 只在本机：不进日志、错误详情或任何投影，不在备份、同步与日志上报的收集范围内。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { PluginMarketFetchAddress } from '../../../shared/pluginMarket.js';
import { readPrivateFile } from './privateFile.js';

/** 密钥目录（owner 的 plugin-market 目录下）。 */
export const SOURCE_ID_KEY_DIR = 'source-id';
const SOURCE_ID_DOMAIN = 'cindy.plugin-market.source-id';
const SOURCE_ID_VERSION = 2;
const KEY_ID_DOMAIN = 'cindy.plugin-market.source-id.key-id';
/** 远程操作发起方（控制端设备身份）的本机不可逆标识，与 sourceId、keyId 域分隔。 */
const CONTROLLER_DOMAIN = 'cindy.plugin-market.operation-controller';
const KEY_TEXT = /^[0-9a-f]{64}$/;
const KEY_FILE = 'key';
const GENERATION = /^v([1-9][0-9]{0,8})$/;
/** 一次 prepare 最多尝试发布几次（每次失败都说明别人刚发布了一代，或本机写不下来）。 */
const PUBLISH_ATTEMPTS = 4;
export const SOURCE_ID_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;

export type MarketSourceIdInput =
  | { kind: 'local'; sourceKey: string }
  | { kind: 'git'; sourceKey: string; address: PluginMarketFetchAddress };

/**
 * 同步计算 sourceId；`prepare` 异步读取（必要时创建）密钥，之前的调用一律返回 null。`keyId()` 是当前密钥的
 * 标识（未备好时为 null），sourceId 只在 keyId 相同时才能互相比较。
 */
export type MarketSourceIdOf = ((input: MarketSourceIdInput) => string | null) & {
  prepare?: () => Promise<void>;
  keyId: () => string | null;
  /**
   * 远程管理操作发起方的本机不可逆标识（契约 V2.9）：同一把密钥、独立域名。安装记录里只存它，不存原始设备号；
   * 未备好密钥时为 null。
   */
  controllerTag?: (controller: string) => string | null;
};

/** 'unreadable'：在但读不到（文件锁、权限、瞬时 I/O），不能当成缺失去重建。 */
async function readKey(keyFile: string): Promise<Buffer | 'missing-or-damaged' | 'unreadable'> {
  const read = await readPrivateFile(keyFile);
  if (read === 'unreadable') return 'unreadable';
  const value = read === 'missing' ? '' : read.text.trim();
  return KEY_TEXT.test(value) ? Buffer.from(value, 'hex') : 'missing-or-damaged';
}

/** 最高的一代；目录不存在为 0，目录在但读不到为 'unreadable'。 */
async function latestGeneration(dir: string): Promise<number | 'unreadable'> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 0 : 'unreadable';
  }
  let latest = 0;
  for (const name of names) {
    const match = GENERATION.exec(name);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  return latest;
}

/**
 * 发布第 `generation` 代：暂存子目录写好完整 key 后整体 rename。目标已存在时 rename 失败，这一代归先到者；
 * 失败不抛（调用方重读即可）。暂存目录总会清掉。
 */
async function publishGeneration(dir: string, generation: number): Promise<void> {
  const staging = path.join(dir, `.staging-${crypto.randomUUID()}`);
  try {
    await fs.promises.mkdir(staging, { recursive: true });
    await fs.promises.writeFile(path.join(staging, KEY_FILE), `${crypto.randomBytes(32).toString('hex')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.promises.rename(staging, path.join(dir, `v${generation}`));
  } catch {
    // 另一个调用方先发布了这一代，或写不下来：都由调用方重读决定。不记录错误详情。
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadOrCreateKey(dir: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const latest = await latestGeneration(dir);
    if (latest === 'unreadable') return null;
    if (latest > 0) {
      const key = await readKey(path.join(dir, `v${latest}`, KEY_FILE));
      if (Buffer.isBuffer(key)) return key;
      if (key === 'unreadable') return null;
    }
    await publishGeneration(dir, latest + 1);
  }
  return null;
}

function keyIdOf(key: Buffer): string {
  return crypto.createHmac('sha256', key).update(KEY_ID_DOMAIN).digest().subarray(0, 9).toString('base64url');
}

/**
 * 绑定到一个数据所有者密钥目录的 sourceId 计算器。密钥由 `prepare()` 异步读取（必要时创建）一次，之后在
 * 本实例内复用；调用方按一次操作新建实例，账号切换不会串到另一个账号的密钥。
 */
export function createMarketSourceIdOf(keyDir: string): MarketSourceIdOf {
  let key: Buffer | null = null;
  let keyId: string | null = null;
  let loading: Promise<void> | undefined;
  const sourceIdOf = ((input: MarketSourceIdInput) => {
    if (typeof input.sourceKey !== 'string' || !input.sourceKey) return null;
    if (!key) return null;
    const parts = input.kind === 'local'
      ? [SOURCE_ID_DOMAIN, SOURCE_ID_VERSION, 'local', input.sourceKey]
      : [
          SOURCE_ID_DOMAIN,
          SOURCE_ID_VERSION,
          'git',
          input.sourceKey,
          input.address.scheme,
          input.address.user,
          input.address.host,
          input.address.port,
          input.address.path,
        ];
    return crypto.createHmac('sha256', key).update(JSON.stringify(parts)).digest().subarray(0, 16).toString('base64url');
  }) as MarketSourceIdOf;
  sourceIdOf.keyId = () => keyId;
  sourceIdOf.controllerTag = (controller) => {
    if (!key || typeof controller !== 'string' || !controller) return null;
    return crypto.createHmac('sha256', key).update(JSON.stringify([CONTROLLER_DOMAIN, 1, controller]))
      .digest().subarray(0, 16).toString('base64url');
  };
  sourceIdOf.prepare = () => (loading ??= loadOrCreateKey(keyDir).then((loaded) => {
    key = loaded;
    keyId = loaded ? keyIdOf(loaded) : null;
  }));
  return sourceIdOf;
}
