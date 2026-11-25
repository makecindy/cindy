import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudAppVersion } from './build-version.mjs';
test('cloud application identity retains the upstream and cloud revision', () => {
  assert.equal(cloudAppVersion('1.2.3-cloud.2', '1.2.3'), '1.2.3-cloud.2');
  for (const value of [undefined, '1.2.3', '1.2.4-cloud.2', '1.2.3-cloud.0', '1.2.3-cloud.02', '1.2.3-cloud.2-cn-amd64']) {
    assert.throws(() => cloudAppVersion(value,'1.2.3'), /CLOUD_APP_VERSION_MISMATCH/);
  }
});
