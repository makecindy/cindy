import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// §3.2 guard (static, kept on purpose for a permission boundary). While a desktop holds the profile, the service
// refuses writes through its allowlist (service.mjs HOST_PATHS_ALLOWED_WHILE_HELD), but server.mjs answers some
// paths itself, outside that allowlist. Twice an entry there wrote data the desktop shares while it was held
// (turning remote control on; /chat creating a task). Every path server.mjs matches must be classified here.
// Failure it catches: a new path in server.mjs that would write shared data during a hold with nobody reviewing
// it. Minimal failing input: add `if (request.method === 'POST' && url.pathname === '/control/x')` to server.mjs.
// Tier: guard (source read, no server started); a root source contract (check-test-hygiene ROOT_SOURCE_CONTRACTS),
// run by `pnpm test:runner`.
test('every path server.mjs answers itself is classified for a desktop hold', () => {
  const source = fs.readFileSync(new URL('../../apps/host/src/server.mjs', import.meta.url), 'utf8');
  const found = new Set();
  for (const m of source.matchAll(/url\.pathname\s*===\s*(?:'([^']*)'|([A-Z][A-Z0-9_]+))/g)) found.add(m[1] ?? m[2]);
  for (const m of source.matchAll(/url\.pathname\.(startsWith|endsWith)\(\s*(?:'([^']*)'|([A-Z][A-Z0-9_]+))\s*\)/g)) {
    found.add(`${m[1]}:${m[2] ?? m[3]}`);
  }
  for (const m of source.matchAll(/\[\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*(?:,\s*)?\]\.includes\(url\.pathname\)/g)) {
    for (const literal of m[1].matchAll(/'([^']*)'/g)) found.add(literal[1]);
  }
  // service: the service gate decides (writes refused while held unless allowlisted).
  // refused: writes refused while held. exception: may write shared data while held, registered in the release
  // table (docs/host/personal-migration-release-table.md). none: writes no data the desktop shares.
  const classified = {
    'startsWith:/api/': 'service',
    'startsWith:/api/auth/': 'service',
    '/api/auth/logout': 'exception: sign-out updates the shared account vault under its cross-process lock',
    '/logout': 'exception: same sign-out as /api/auth/logout',
    'startsWith:HOST_IPC_PATH_PREFIX': 'none: the bound IPC channels read only (ipc-bindings)',
    '/chat': 'refused: a new task at the entry check before it is created; input to an existing task by the queue',
    '/control/remote': 'refused for enable and Agent-Net on/off; exception for disable and revoke; status reads',
    '/control/stop': 'exception: stopping finishes accepted work (queue drain, usage, error rows)',
    '/control/attachment': 'none', HOST_IPC_MANIFEST_PATH: 'none', '/control/platform': 'none',
    '/web/pair': 'none', '/web/session': 'none', '/events': 'none', '/health': 'none', '/me': 'none',
    '/plugins': 'none', '/sessions': 'none', 'startsWith:/sessions/': 'none', 'endsWith:/messages': 'none',
    '/connect': 'none', '/connect.js': 'none', '/': 'none', '/shim.js': 'none', 'startsWith:/assets/': 'none',
  };
  assert.deepEqual([...found].filter(path => !(path in classified)).sort(), [], 'paths server.mjs answers that are not classified');
  assert.deepEqual(Object.keys(classified).filter(path => !found.has(path)).sort(), [], 'classified paths server.mjs no longer answers');
});

// Guard tier: the integration cases run the real queue and service factories;
// moving only one main.ts caller to a boolean hold would leave those cases green.
test('main binds all four profile writers and the installed memory MCP provider to the live queue', () => {
  const main = fs.readFileSync(new URL('../../apps/host/src/main.ts', import.meta.url), 'utf8');
  assert.ok(/const profileServices = bindHostProfileServices\(\{\s*profileHoldReason: inputQueue\.profileHoldReason,\s*profileHoldGeneration: inputQueue\.profileHoldGeneration,/.test(main), 'profile queue binding');
  assert.ok(/hostTools = profileServices\.tools\(/.test(main), 'host tools');
  assert.ok(/const memory = profileServices\.memory\(/.test(main), 'memory services');
  assert.ok(/makerMemory = memory\.manager;/.test(main), 'installed memory manager');
  assert.ok(/mcpProviders: await pluginGateway\.prepareMcpProviders\(\[\.\.\.hostTools\.providers, \.\.\.memory\.providers\(/.test(main), 'installed memory MCP');
  assert.ok(/updateProjectInfo: profileServices\.project\(/.test(main), 'project update');
  assert.ok(/const runtimePluginSettings = profileServices\.plugins\(/.test(main), 'task plugin settings');
});
