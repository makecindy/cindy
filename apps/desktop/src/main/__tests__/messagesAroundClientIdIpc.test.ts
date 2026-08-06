import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

const messagesIpcSource = readTextLf(
  resolve(__dirname, '..', 'localDb', 'ipc', 'messages.ts'),
  'utf8',
);
const preloadSource = readTextLf(
  resolve(__dirname, '..', '..', 'preload', 'preload.ts'),
  'utf8',
);
const viteEnvSource = readTextLf(
  resolve(__dirname, '..', '..', 'renderer', 'vite-env.d.ts'),
  'utf8',
);

describe('messages around-client-id IPC boundary', () => {
  it('exposes the clientId-based around lookup across main, preload, and renderer types', () => {
    expect(messagesIpcSource).toContain('ipcMain.handle(\n    IPC_CHANNELS.LOCAL_DB.MESSAGES_AROUND_CLIENT_ID');
    expect(preloadSource).toContain('aroundClientId: (');
    expect(preloadSource).toContain('IPC_CHANNELS.LOCAL_DB.MESSAGES_AROUND_CLIENT_ID');
    expect(viteEnvSource).toContain('aroundClientId: (');
  });
});
