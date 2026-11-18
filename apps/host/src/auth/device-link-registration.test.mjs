import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cindy/device-link';

import { restoreDeviceLinkRegistration } from './device-link-registration.mjs';

/**
 * 测试价值
 * - 生产入口与可观察结果：restoreDeviceLinkRegistration（`cindy-host login` 登录成功后调用），对一个本机 WebSocket 中转说一次 hello。
 * - Bug／规则依据：2026-11-17 真机，从另一台电脑删掉 Host 后重新登录，Host 启动时用的是刷新出来的令牌，Device Link 一直回
 *   4410「设备已移除，请重新登录」，Host 再也回不来（Agent-Net 也按 Device Link 列表不认它）。服务端只认刚登录的令牌恢复登记。
 * - 现有覆盖缺口：登录只测到保存会话；没有任何地方用刚登录的令牌连 Device Link。
 * - 最小失败输入：中转回 hello-ack 时算恢复；中转用 4410 关掉时如实报「仍被移除」。
 * - tier：unit，本机回环 WebSocket，不连真实服务。
 */
test('says hello once with the fresh sign-in token and reports whether Device Link took it back', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const seen = [];
  let refuse = false;
  server.on('connection', (socket, request) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      seen.push({ authorization: request.headers.authorization, path: request.url, frame });
      if (refuse) socket.close(4410, 'device removed; sign in again to register');
      else socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: { deviceId: 'host', userId: 'u' } }));
    });
  });
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const createWebSocket = async (url, headers) => new WebSocket(url, { headers });

  assert.equal(await restoreDeviceLinkRegistration({ apiBaseUrl, token: 'fresh-sign-in', version: '1.2.3', createWebSocket }), 'registered');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, 'Bearer fresh-sign-in');
  assert.equal(seen[0].path, '/api/device-link/ws');
  assert.equal(seen[0].frame.kind, 'hello');
  assert.equal(seen[0].frame.payload.appVersion, '1.2.3');
  assert.equal(seen[0].frame.payload.remoteControlEnabled, false);

  refuse = true;
  assert.equal(await restoreDeviceLinkRegistration({ apiBaseUrl, token: 'refreshed', version: '1.2.3', createWebSocket }), 'removed');
});
