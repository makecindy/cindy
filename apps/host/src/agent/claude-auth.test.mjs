import assert from 'node:assert/strict';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { activeDataOwnerId, isOwnerBoundaryPending, ownerScopedPath } from '../../../desktop/src/main/ownerContext.ts';

test('host owner facts are installed explicitly and fail closed without an owner', async () => {
  configureHostOwner({ userDataDir: '/tmp/cindy-host-owner-test', ownerId: 'owner-x' });
  assert.equal(activeDataOwnerId(), 'owner-x');
  assert.equal(isOwnerBoundaryPending(), false);
  assert.match(ownerScopedPath('file.json'), /owners[\\/][0-9a-f]{20}[\\/]file\.json$/);

  configureHostOwner({ userDataDir: '/tmp/cindy-host-owner-test', ownerId: null });
  assert.equal(activeDataOwnerId(), null);
  assert.throws(() => ownerScopedPath('file.json'), /no active owner/);
});
