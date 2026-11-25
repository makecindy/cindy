/**
 * 自定义市场来源的不透明标识（sourceId，契约第 2 版 V2.2）。
 *
 * sourceId = base64url(HMAC-SHA256(K, CONTEXT + marketSourceKey)) 的前 16 字节。
 * - 来源指纹 `marketSourceKey` 含类型、完整地址或本地路径、ref 与稀疏路径，所以不同本地目录、
 *   同主机不同端口、不同协议写法与稀疏路径得到不同的标识。
 * - 用 HMAC 而不是裸哈希：本地路径和仓库地址熵低，裸哈希可被穷举反推。
 * - 密钥 K 每个数据所有者一把（`owners/<账号>/plugin-market/source-id.key`），32 字节随机，0600，
 *   首次需要时排他创建一次；只在本机，不进日志、错误详情或任何投影。
 * - K 存在但读不出或格式不对时不覆盖、不重建：所有 sourceId 缺省，控制端按「未核实」处理。
 *   K 被删除后重建只会让旧标识对不上（控制端保守地「未确认」），不影响已装插件、批准状态或账本。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_ID_KEY_FILE = 'source-id.key';
const SOURCE_ID_CONTEXT = 'cindy.plugin-market.source-id.v1\u0000';
const KEY_TEXT = /^[0-9a-f]{64}$/;

function parseKey(text: string): Buffer | null {
  const value = text.trim();
  return KEY_TEXT.test(value) ? Buffer.from(value, 'hex') : null;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

/**
 * 读密钥；文件不存在时排他创建。先写同目录临时文件再 link 到目标：link 在目标已存在时失败，
 * 并发的两个创建者只有一个成功，另一个读胜者的文件；进程中途被杀也不会留下半截密钥文件。
 */
function loadOrCreateKey(keyPath: string): Buffer | null {
  try {
    return parseKey(fs.readFileSync(keyPath, 'utf8'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return null;
  }
  const temp = `${keyPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(temp, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(temp, keyPath);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return null;
    }
    return parseKey(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 临时文件不存在或已删除。
    }
  }
}

/**
 * 绑定到一个数据所有者密钥路径的 sourceId 计算器。密钥在第一次调用时读取（必要时创建）一次，
 * 之后在本实例内复用；调用方按一次操作新建实例，账号切换不会串到另一个账号的密钥。
 */
export function createMarketSourceIdOf(keyPath: string): (sourceKey: string) => string | null {
  let key: Buffer | null | undefined;
  return (sourceKey) => {
    if (typeof sourceKey !== 'string' || !sourceKey) return null;
    if (key === undefined) key = loadOrCreateKey(keyPath);
    if (!key) return null;
    return crypto
      .createHmac('sha256', key)
      .update(SOURCE_ID_CONTEXT + sourceKey)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  };
}
