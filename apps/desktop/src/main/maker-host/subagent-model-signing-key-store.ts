// Host 的子代理执行策略 Ed25519 密钥对(P1-8 / P0-B)。
//
// 数学上保证 Agent 不能凭空「生成」Host 授权:
//   - 授权**判断**只在可信 Host 边界(Desktop 主进程)做出:buildSnapshot 签名。
//   - 扩展/runner 的 verifier 只凭**公钥**校验;公钥分发给 verifier 安全。
//   - 私钥只留在可信边界(owner 隔离 userData,0600),永不进 Agent env。
// P0-B:0600 ≠ 进程隔离;本文件保证的是**非对称密码学不可伪造性**,而非
// 同用户进程间的保密性。同权限 Agent 即使可读公钥,也无法生成有效签名。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-signing-key-store');

const SECRET_FILE_NAME = 'subagent-model-signing-key.json'; // 私钥(0600)
const PUBLIC_FILE_NAME = 'subagent-model-signing-public-key.json'; // 公钥

let cached: { secretFilePath: string; publicFilePath: string; publicKey: string; secretKey: string; publicKeyObject: KeyObject } | undefined;

function baseDir(): string {
  const root = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  return root ?? app.getPath('userData');
}

function readExisting(secretPath: string): { publicKey: string; secretKey: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath, 'utf8')) as { publicKey?: unknown; secretKey?: unknown };
    if (typeof parsed.publicKey !== 'string' || typeof parsed.secretKey !== 'string') return undefined;
    // 校验确可使用,不可用则视为不存在 -> 重新生成并覆盖(DRY run Draft 期无生产依赖)。
    createPublicKey({ key: Buffer.from(parsed.publicKey, 'base64'), format: 'der', type: 'spki' });
    createPrivateKey({ key: Buffer.from(parsed.secretKey, 'base64'), format: 'der', type: 'pkcs8' });
    return { publicKey: parsed.publicKey, secretKey: parsed.secretKey };
  } catch {
    return undefined;
  }
}

export function writePublicKeyFile(publicKey: string): string {
  const filePath = path.join(baseDir(), PUBLIC_FILE_NAME);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, publicKey }, null, 2), { mode: 0o644 });
  } catch (error) {
    log.warn('failed to write public key file; verifiers will fail closed', { message: String(error) });
  }
  return filePath;
}

/**
 * 读或生成 Ed25519 密钥对。所有 Host 侧签发都走这里;扩展/runner 只读公钥文件校验。
 */
export function getOrCreateSubagentModelSigningKey(): {
  publicKey: string; secretKey: string; publicKeyObject: KeyObject;
  secretFilePath: string; publicFilePath: string;
} {
  const secretPath = path.join(baseDir(), SECRET_FILE_NAME);
  const publicPath = path.join(baseDir(), PUBLIC_FILE_NAME);
  if (cached?.secretFilePath === secretPath) return cached;
  const existing = readExisting(secretPath);
  if (existing) {
    const publicKeyObject = createPublicKey({ key: Buffer.from(existing.publicKey, 'base64'), format: 'der', type: 'spki' });
    writePublicKeyFile(existing.publicKey);
    cached = { secretFilePath: secretPath, publicFilePath: publicPath, publicKey: existing.publicKey, secretKey: existing.secretKey, publicKeyObject };
    return cached;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const secB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, JSON.stringify({ version: 1, publicKey: pubB64, secretKey: secB64 }, null, 2), { mode: 0o600 });
    log.info('subagent model signing keypair created', { secretFilePath: secretPath });
  } catch (error) {
    log.warn('failed to persist signing keypair; snapshot signing will fail closed', { message: String(error) });
    throw error;
  }
  writePublicKeyFile(pubB64);
  cached = { secretFilePath: secretPath, publicFilePath: publicPath, publicKey: pubB64, secretKey: secB64, publicKeyObject: publicKey };
  return cached;
}
