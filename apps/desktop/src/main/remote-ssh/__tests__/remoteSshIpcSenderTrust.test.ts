import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

function handlerBody(channel: string, nextChannel: string): string {
  const start = source.indexOf(`ipcMain.handle(REMOTE_SSH_INVOKE.${channel}`);
  const end = source.indexOf(`ipcMain.handle(REMOTE_SSH_INVOKE.${nextChannel}`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('remote SSH profile mutation IPC sender trust', () => {
  it.each([
    ['ADD', 'UPDATE'],
    ['UPDATE', 'REMOVE'],
    ['REMOVE', 'COPY_TO_CINDY'],
    ['COPY_TO_CINDY', 'CONNECT'],
  ])('%s rejects non-app frames before parsing or persistence', (channel, nextChannel) => {
    const body = handlerBody(channel, nextChannel);
    const guard = body.indexOf('assertTrustedAppRendererEvent(event);');
    expect(guard).toBeGreaterThan(-1);
    const firstSideEffect = Math.min(
      ...[
        body.indexOf('normalizeAddInput('),
        body.indexOf('persistRemoteHostData('),
        body.indexOf('requireObject('),
      ].filter((index) => index >= 0),
    );
    expect(guard).toBeLessThan(firstSideEffect);
  });

  it('SET_AUTO_CONNECT rejects non-app frames before parsing or persistence', () => {
    const start = source.indexOf('ipcMain.handle(REMOTE_SSH_INVOKE.SET_AUTO_CONNECT');
    const end = source.indexOf('ipcMain.handle(REMOTE_SSH_INVOKE.HAS_ANY_AUTO_CONNECT_HOST', start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const guard = body.indexOf('assertTrustedAppRendererEvent(_event);');
    expect(guard).toBeGreaterThan(-1);
    const firstSideEffect = Math.min(
      ...[
        body.indexOf('requireObject('),
        body.indexOf('persistRemoteHostData('),
        body.indexOf('setSshHostAutoConnect('),
      ].filter((index) => index >= 0),
    );
    expect(guard).toBeLessThan(firstSideEffect);
  });
});
