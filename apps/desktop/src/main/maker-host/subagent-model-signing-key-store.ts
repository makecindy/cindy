// Host 的子代理执行策略 signing key(P1-8)。
//
// 数学上保证 Agent 不能凭空「生成」Host 授权:HMAC key 只由 Desktop 主进程
// 在 owner 隔离的 userData 下生成/读取(文件 0600),随 spawnEnv 以**文件路径**
// (CINDY_PI_SUBAGENT_POLICY_KEY_FILE)交给扩展/runner;校验时才读取。
// Agent 改写运行期快照或 runner config 后,签名必然断裂 -> fail-closed。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-signing-key-store');

const KEY_FILE_NAME = 'subagent-model-signing-key.json';
const KEY_LENGTH = 32;

let cached: { filePath: string; key: Buffer } | undefined;

function keyFilePath(): string {
  const root = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  return path.join(root ?? app.getPath('userData'), KEY_FILE_NAME);
}

function readExistingKey(filePath: string): Buffer | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { key?: unknown };
    if (typeof parsed.key !== 'string') return undefined;
    const key = Buffer.from(parsed.key, 'base64');
    return key.length >= 16 ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读或生成 signing key。所有 Host 侧签发都走这里;扩展/runner 侧通过
 * 同一路径读取校验(见 cindy-subagent-source / runner 的镜像逻辑)。
 */
export function getOrCreateSubagentModelSigningKey(): { key: Buffer; filePath: string } {
  const filePath = keyFilePath();
  if (cached?.filePath === filePath) return cached;
  const existing = readExistingKey(filePath);
  if (existing) {
    cached = { filePath, key: existing };
    return cached;
  }
  const key = randomBytes(KEY_LENGTH);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, key: key.toString('base64') }, null, 2), {
      mode: 0o600,
    });
    log.info('subagent model signing key created', { filePath });
  } catch (error) {
    log.warn('failed to persist signing key; snapshot signing will fail closed', { message: String(error) });
    throw error;
  }
  cached = { filePath, key };
  return cached;
}
