import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import { listInstalledPlugins } from './plugins.mjs';

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-plugins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('lists canonical plugin instances with manifest identity', (t) => {
  const userDataDir = tempProfile(t);
  const ownerId = 'owner-1';
  const ownerRoot = path.join(userDataDir, 'owners', dataOwnerStorageKey(ownerId));
  fs.mkdirSync(path.join(ownerRoot, 'ghost-install-state'), { recursive: true });
  fs.mkdirSync(path.join(ownerRoot, 'cindy-brain/_ns/_root/demo'), { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'cindy-brain/_ns/_root/demo/ghost.json'),
    JSON.stringify({ name: 'Demo plugin', version: '1.2.3' }));
  fs.writeFileSync(path.join(ownerRoot, 'ghost-install-state/plugin-instances.v2.json'), JSON.stringify({
    schemaVersion: 2,
    instances: {
      _root__demo: {
        instanceKey: '_root__demo', contentRelId: 'cindy-brain/_ns/_root/demo',
        ghostId: 'demo', namespace: null, source: 'market', active: true,
      },
    },
  }));

  const result = listInstalledPlugins(userDataDir, ownerId);
  assert.deepEqual(result.plugins, [{
    instanceKey: '_root__demo', id: 'demo', name: 'Demo plugin', version: '1.2.3',
    namespace: null, source: 'market', active: true,
  }]);
  assert.equal(result.namespace, 'canonical');
  assert.equal(result.legacyNamespacePresent, false);
});

test('reports legacy namespaces without reading them', (t) => {
  const userDataDir = tempProfile(t);
  fs.mkdirSync(path.join(userDataDir, 'owners', 'raw-owner-id'), { recursive: true });
  const result = listInstalledPlugins(userDataDir, 'owner-1');
  assert.deepEqual(result.plugins, []);
  assert.equal(result.legacyNamespacePresent, true);
});

test('a missing profile yields an empty list rather than an error', (t) => {
  const userDataDir = tempProfile(t);
  assert.deepEqual(listInstalledPlugins(userDataDir, 'nobody'), {
    plugins: [], namespace: 'canonical', legacyNamespacePresent: false,
  });
});
