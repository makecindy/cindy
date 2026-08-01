import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { resolveEasBuildProfileEnv } from '../check-endpoint-literals.mjs';

test('提交的 EAS build profiles 不包含生产端点 env（含 extends）', () => {
  const eas = JSON.parse(
    fs.readFileSync(new URL('../../apps/mobile/eas.json', import.meta.url), 'utf8'),
  );

  for (const profileName of Object.keys(eas.build)) {
    const env = resolveEasBuildProfileEnv(eas.build, profileName);
    assert.equal(env.EXPO_PUBLIC_FEISHU_APP_ID, undefined, profileName);
    assert.equal(env.EXPO_PUBLIC_XDT_API_BASE_URL, undefined, profileName);
    assert.equal(env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL, undefined, profileName);
    assert.equal(env.EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL, undefined, profileName);
    assert.equal(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL, undefined, profileName);
    assert.equal(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL, undefined, profileName);
  }
  assert.equal(resolveEasBuildProfileEnv(eas.build, 'testflight').EXPO_PUBLIC_CINDY_AUTH_REGION, 'cn');
});

test('EAS extends 解析支持子级覆盖，并拒绝缺失父级与循环', () => {
  assert.deepEqual(
    resolveEasBuildProfileEnv(
      {
        base: { env: { A: 'base', B: 'base' } },
        child: { extends: 'base', env: { B: 'child' } },
      },
      'child',
    ),
    { A: 'base', B: 'child' },
  );
  assert.throws(
    () => resolveEasBuildProfileEnv({ child: { extends: 'missing' } }, 'child'),
    /不存在或格式非法/,
  );
  assert.throws(
    () => resolveEasBuildProfileEnv({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a'),
    /extends 循环/,
  );
});

test('dev endpoint 模板保留 Telegram 字段但默认不启用', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../config/endpoint.dev.json.example', import.meta.url), 'utf8'),
  );

  assert.equal(manifest.telegramHookWsUrl, '');
});
