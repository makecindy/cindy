import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hostOutbound } from './outbound.mjs';
import { createHostServerApi } from './server-api.ts';
import { configureUserDataDir } from '../../desktop/src/main/userDataPath.ts';

// 测试价值：生产入口 createHostServerApi（Host 给桌面请求合同的端口）。规则：服务端回 401 时，桌面的请求合同以
// `serverRejectedToken: true` 调续期，Host 的续期据此在网络失败后的等待里提前一次（C，与桌面 AuthRefreshBackoff 相同）。
// 缺口：Host 原来的端口不传参数，这个信号丢在半路；没有用例经过它。最小失败输入：一次 401。tier：unit（替换出站 fetch）。
test('a 401 from the server reaches the Host renewal as server evidence', async (t) => {
  // The request contract logs the 401; the log goes to a temporary profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-server-api-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureUserDataDir(profile);
  t.mock.method(hostOutbound, 'outboundFetch', async () =>
    new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'expired' } }), { status: 401 }));
  const renewals = [];
  const request = createHostServerApi({
    token: () => 'synthetic-access', locale: () => 'en', invalidate: async () => {},
    refresh: async (options) => { renewals.push(options); return false; },
  });
  await assert.rejects(request('/api/fixture', { baseUrl: 'https://example.invalid' }));
  assert.deepEqual(renewals, [{ serverRejectedToken: true }]);
});
