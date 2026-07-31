/** Main 内部的通讯录本地变更事件；不携带联系人内容。 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ownerScopedUserDataPath } from '../appSessionState.js';

const listeners = new Set<() => void>();
const CHANGE_TOKEN_FILENAME = 'change-token';

function changeTokenPath(): string {
  return ownerScopedUserDataPath('maker-contacts', CHANGE_TOKEN_FILENAME);
}

/** Device Link 持有者轮询的无内容版本标记；读取失败按“暂无标记”处理。 */
export function readContactsChangeToken(): string | null {
  try {
    return fs.readFileSync(changeTokenPath(), 'utf8') || null;
  } catch {
    return null;
  }
}

function persistContactsChangeToken(): void {
  try {
    const file = changeTokenPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // token 不含联系人数据；跨进程唯一即可，不承担排序或计数语义。
    fs.writeFileSync(file, randomUUID(), 'utf8');
  } catch {
    // 标记失败只退化到 30 分钟校准，不能把已成功的联系人写入伪装成失败。
  }
}

export function onLocalContactsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLocalContactsChanged(): void {
  persistContactsChangeToken();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 后台同步监听失败不能把已成功的通讯录写入伪装成 IPC 失败。
    }
  }
}
