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
 * 密钥 K：每个数据所有者一把（`owners/<账号>/plugin-market/source-id.key`），32 字节随机。
 * - 读写都是异步的（`prepare()`）：市场列表、详情、远程目录这些 IPC 读路径会用到它，不能阻塞主线程。
 *   同步的计算函数只用已经读好的密钥，没读好就返回 null（身份缺省），从不回退到同步读盘。
 * - 缺失或内容损坏时重建：同目录 0600 临时文件 + rename 落位（privateFile.ts），
 *   再读回实际落位的那份来用；并发首次创建的多个实例最终读到同一把，瞬时不一致只会让控制端保守地
 *   「未确认」。Windows 上 POSIX 权限位不生效，与其它本机状态文件一样依赖用户 profile 目录的 ACL。
 * - 文件在但读不到（文件锁、权限）时不重建，本次没有 sourceId。
 * - 重建后旧标识对不上，控制端按「未确认」处理，不影响已装插件、批准状态或账本。
 * - 只在本机：不进日志、错误详情或任何投影，不在备份、同步与日志上报的收集范围内。
 */
import crypto from 'node:crypto';

import type { PluginMarketFetchAddress } from '../../../shared/pluginMarket.js';
import { readPrivateFile, writePrivateFileAtomic } from './privateFile.js';

export const SOURCE_ID_KEY_FILE = 'source-id.key';
const SOURCE_ID_DOMAIN = 'cindy.plugin-market.source-id';
const SOURCE_ID_VERSION = 2;
const KEY_TEXT = /^[0-9a-f]{64}$/;

export type MarketSourceIdInput =
  | { kind: 'local'; sourceKey: string }
  | { kind: 'git'; sourceKey: string; address: PluginMarketFetchAddress };

/**
 * 同步计算 sourceId；`prepare` 异步读取（必要时创建）密钥，之前的调用一律返回 null。测试里的假实现可以不带
 * `prepare`。
 */
export type MarketSourceIdOf = ((input: MarketSourceIdInput) => string | null) & {
  prepare?: () => Promise<void>;
};

/** 'unreadable'：文件在但读不到（文件锁、权限、瞬时 I/O），不能当成缺失去覆盖。 */
async function readKey(keyPath: string): Promise<Buffer | 'missing-or-damaged' | 'unreadable'> {
  const read = await readPrivateFile(keyPath);
  if (read === 'unreadable') return 'unreadable';
  const value = read === 'missing' ? '' : read.text.trim();
  return KEY_TEXT.test(value) ? Buffer.from(value, 'hex') : 'missing-or-damaged';
}

async function loadOrCreateKey(keyPath: string): Promise<Buffer | null> {
  const existing = await readKey(keyPath);
  if (Buffer.isBuffer(existing)) return existing;
  if (existing === 'unreadable') return null;
  try {
    await writePrivateFileAtomic(keyPath, `${crypto.randomBytes(32).toString('hex')}\n`, { createDir: true });
  } catch {
    // 写不下来就没有 sourceId（控制端按无法核实处理）；不记录错误详情。
  }
  const created = await readKey(keyPath);
  return Buffer.isBuffer(created) ? created : null;
}

/**
 * 绑定到一个数据所有者密钥路径的 sourceId 计算器。密钥由 `prepare()` 异步读取（必要时创建）一次，之后在
 * 本实例内复用；调用方按一次操作新建实例，账号切换不会串到另一个账号的密钥。
 */
export function createMarketSourceIdOf(keyPath: string): MarketSourceIdOf {
  let key: Buffer | null = null;
  let loading: Promise<void> | undefined;
  const sourceIdOf: MarketSourceIdOf = (input) => {
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
  };
  sourceIdOf.prepare = () => (loading ??= loadOrCreateKey(keyPath).then((loaded) => {
    key = loaded;
  }));
  return sourceIdOf;
}
