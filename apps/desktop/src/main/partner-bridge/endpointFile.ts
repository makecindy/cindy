/**
 * partner-bridge/endpointFile.ts
 * ---------------------------------------------------------------------------
 * 把「端口 + token」写到本机一个 0600 的文件里,供同一台机器上的调用方读取。
 *
 * 为什么用文件而不是环境变量:调用方是别的进程、甚至别的语言写的服务,它们
 * 启动时机与 Cindy 无关;文件是唯一不需要两边约定启动顺序的通道。目录 0700、
 * 文件 0600 —— 同机同用户的进程本来就有等价权限,不给其它用户开口子。
 *
 * 文件内容:{ port, token, pid, startedAt, protocol: 'cindy-partner-bridge/1' }
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface PartnerEndpointInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  protocol: 'cindy-partner-bridge/1';
}

export function writePartnerEndpointFile(dir: string, info: PartnerEndpointInfo): string {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const file = path.join(dir, 'endpoint.json');
  // 先写同目录临时文件再 rename:调用方不会读到写了一半的 JSON。
  const tmp = path.join(dir, `endpoint.${process.pid}.tmp`);
  const payload = JSON.stringify({ ...info, url: `http://127.0.0.1:${info.port}` }, null, 2);
  fs.writeFileSync(tmp, payload, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, FILE_MODE);
  return file;
}

/** 退出时清掉端点文件(下次启动重新分配端口与 token)。 */
export function removePartnerEndpointFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* 清理是尽力而为 */
  }
}
