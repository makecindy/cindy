// Host 的子代理执行策略 Ed25519 密钥对(P0-B 真正隔离)。
//
// 威胁模型:Agent 具备 Shell、文件读写与子进程执行能力,UA 同机同 UID。
// 本模块的隔离目标(与 Desktop `pi-proxy-session-token` 先例一致):
//
//   - **私钥永不以明文落盘。** 持久化只存 `safeStorage.encryptString(...)` 的
//     密文(写入现有 `userData/subagent-model-signing-key.json`,
//     `{ version: 2, encrypted }`)。同 UID 的 Agent 即使读到该文件,也只拿到
//     密文 —— `safeStorage` 的加密主密钥由 OS Keychain(或 Windows DPAPI)
//     持有,且条目只对本 App 进程开放,Agent 进程无法解开。
//   - **safeStorage 不可用时**降级为纯内存密钥(进程内生成,不写任何文件);
//     进程重启后旧快照失效(快照本身只有 24h 时效),签名能力随进程重建。
//     这比「把明文私钥写到 0600 文件里」更安全,且语义不变(签发点仍只在
//     Host)。
//   - **公钥没有文件。** Host 从内存取 `.publicKey`,以 env 字面量注入
//     (`CINDY_PI_SUBAGENT_POLICY_PUBLIC_KEY`),verifier 直接从 env 解码。
//     因此不存在 `public-key.json` 供 Agent 替换;不存在 Host 私钥路径
//     暴露给 env 的问题。
//   - 旧的明文 keypair 文件(`{ version: 1, publicKey, secretKey }`)在新代码
//     下被忽略并尝试删除(防 beta 期明文残留)。绝不从磁盘读明文私钥。
//
// 残留声明(诚实):同 UID 恶意 Agent 对其他文件的篡改(例如在 session 中途
// 重写已生成的 `runner.cjs` / 扩展源)仍超出本进程架构的隔离能力 —— Host 在
// 每次 session 启动时重新生成扩展,第二道闸在已加载的扩展模块内,跨 session
// 重启即恢复。完整 UID 隔离需要独立 UID 的常驻 Helper + 受控 IPC,对于
// sandboxed 桌面 App 属于过度设计,未在本 PR 实现;SECURITY_DESIGN.md
// 威胁模型中显式标注。
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-signing-key-store');

const SECRET_FILE_NAME = 'subagent-model-signing-key.json'; // 只存 safeStorage 密文

type KeyPair = {
  /** SPKI DER base64 公钥 —— 可以明文分发给 verifier。 */
  publicKey: string;
  /** PKCS8 DER base64 私钥 —— 永不落盘,只活在 Desktop 主进程内存里。 */
  secretKey: string;
  publicKeyObject: KeyObject;
};

let cached: KeyPair | undefined;

function secretFilePath(): string {
  const root = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  return path.join(root ?? app.getPath('userData'), SECRET_FILE_NAME);
}

/** 校验确为可用 Ed25519 密钥对 —— 供回读与签名路径复用。 */
function validKeyPair(publicKey: string, secretKey: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const priv = createPrivateKey({ key: Buffer.from(secretKey, 'base64'), format: 'der', type: 'pkcs8' });
    return pub.asymmetricKeyType === 'ed25519' && priv.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** 尝试解密已落盘的密文 —— 仅 Desktop 主进程经 safeStorage 解出明文。 */
function readEncrypted(): KeyPair | undefined {
  let parsed: { version?: unknown; encrypted?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(secretFilePath(), 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed?.version !== 2 || typeof parsed.encrypted !== 'string' || !parsed.encrypted) {
    // 旧版明文文件({ version: 1, secretKey })或未知格式:尝试清理,不做任何读取。
    bestEffortUnlinkLegacy();
    return undefined;
  }
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  let plaintext: string;
  try {
    plaintext = safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'));
  } catch {
    return undefined;
  }
  let pair: { publicKey?: unknown; secretKey?: unknown };
  try {
    pair = JSON.parse(plaintext) as { publicKey?: unknown; secretKey?: unknown };
  } catch {
    return undefined;
  }
  if (typeof pair.publicKey !== 'string' || typeof pair.secretKey !== 'string') return undefined;
  if (!validKeyPair(pair.publicKey, pair.secretKey)) return undefined;
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyObject: createPublicKey({ key: Buffer.from(pair.publicKey, 'base64'), format: 'der', type: 'spki' }),
  };
}

function persistEncrypted(pair: { publicKey: string; secretKey: string }): void {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage encryption unavailable; subagent signing key kept in memory for this process only');
    return;
  }
  try {
    const filePath = secretFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({
      publicKey: pair.publicKey,
      secretKey: pair.secretKey,
    }));
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, encrypted: encrypted.toString('base64') }, null, 2), { mode: 0o600 });
  } catch (error) {
    // 持久化失败不阻塞本次运行 —— 内存密钥继续工作;下次启动重新生成。
    log.warn('failed to persist encrypted subagent signing key; snapshot signing will fail after process restart', {
      message: String(error),
    });
  }
}

function bestEffortUnlinkLegacy(): void {
  try {
    fs.unlinkSync(secretFilePath());
    log.warn('removed legacy plaintext subagent signing key file (P0-B hygiene)');
  } catch { /* 无法删除也不阻塞;新代码永远不会读它 */ }
}

function freshPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const secB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  persistEncrypted({ publicKey: pubB64, secretKey: secB64 });
  return { publicKey: pubB64, secretKey: secB64, publicKeyObject: publicKey };
}

/**
 * 读或生成 Ed25519 密钥对。**私钥只活在 Desktop 主进程内存里**,
 * 以 safeStorage 密文(或仅内存)形式存在,Agent 同 UID 文件读到也解不开。
 * 扩展/runner 只凭内存公钥(env 字面量)验签 —— 没有 public-key 文件可替换。
 */
export function getOrCreateSubagentModelSigningKey(): KeyPair {
  if (cached) return cached;
  cached = readEncrypted() ?? freshPair();
  return cached;
}

/** 供测试重置进程内缓存,不删任何落盘密文。 */
export function __resetSigningKeyCacheForTests(): void {
  cached = undefined;
}
