import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Unit regression: run the real startup/auth functions with in-memory network,
// credentials and storage. A valid login for B must never open A's database.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['ensureRuntime', 'resolveAccountUser'].includes(node.name?.text)) {
    functions.push(node.getText(source).replaceAll('import.meta.url', "'file:///test/main.ts'"));
  } else ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`
let activeOwner = null, runtimeLease = null, currentSessionToken = null, accountUser = null;
let account = { authenticated: false, realm: 'global' };
const runtime = { owner: null };
${functions.join('\n')}
return { start: ensureRuntime, resolve: resolveAccountUser, token: () => currentSessionToken };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup() {
  const opens = [];
  const deps = {
    resolveHostDataDir: () => 'isolated-test-profile',
    configureHostOwner: () => {},
    acquireHostRuntimeLease: () => ({ held: true, release() {} }),
    readAdoptedSessionState: async () => ({ authenticated: true, realm: 'global' }),
    openOwnerDatabase: async (args) => { opens.push(args); throw new Error('database opened'); },
    path: { join: (...parts) => parts.join('/') }, desktopRoot: 'desktop', process,
    resolveHostRegion: () => 'global', readAuthEndpoints: () => ({ authApiBaseUrl: 'https://example.invalid' }),
    createCredentialStore: async () => ({}), createRequire: () => () => ({ machineIdSync: () => 'test-device' }),
    CindyAuthClient: class { async getMe() { return { membership: { id: 'account-b' } }; } },
    refreshHostSession: async () => ({ sessionToken: 'synthetic-test-value' }),
    ACCOUNT_DEFAULT_MODEL: 'test-model', ACCOUNT_DEFAULT_EFFORT: 'medium',
    // The former startup refresh swallowed mismatch errors and still opened storage.
    refreshAuthSession: async () => false,
  };
  // import.meta.url is only passed to the injected createRequire stub.
  const code = compiled.replaceAll('import.meta.url', "'file:///test/main.ts'");
  return { ...new Function(...Object.keys(deps), code)(...Object.values(deps)), opens };
}

test('startup rejects a different signed-in owner before opening storage', async () => {
  const h = setup();
  await assert.rejects(h.start('account-a'), /does not match/);
  assert.deepEqual(h.opens, []);
  assert.equal(h.token(), null);
});

test('matching owner authentication proceeds to its own database', async () => {
  const h = setup();
  await assert.rejects(h.start('account-b'), /database opened/);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].ownerId, 'account-b');
});
