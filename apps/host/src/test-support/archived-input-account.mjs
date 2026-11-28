import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

if (isMainThread) register(import.meta.url);
const queue = new URL('../agent/input-queue.mjs', import.meta.url).href;
const fixtureQueue = 'cindy:archived-input-queue';
const authModules = new Set([
  new URL('../credentials/store.mjs', import.meta.url).href,
  new URL('../auth-fetch.mjs', import.meta.url).href,
]);

export function resolve(specifier, context, next) {
  if (context.parentURL && specifier.startsWith('.')) {
    const requested = new URL(specifier, context.parentURL).href;
    if (authModules.has(requested)) return { url: import.meta.url, shortCircuit: true };
    if (requested === queue) return { url: fixtureQueue, shortCircuit: true };
  }
  return next(specifier, context);
}

// Keep the production queue, session reader, route lock, restore and SQLite writes.
// Supply only the terminal SDK and skip selection of a real vendor account.
export function load(url, context, next) {
  if (url !== fixtureQueue) return next(url, context);
  return {
    format: 'module',
    shortCircuit: true,
    source: `
      import { createInputQueue as production } from ${JSON.stringify(queue)};
      import { createFakeMaker } from ${JSON.stringify(new URL('./input-queue-maker.mjs', import.meta.url).href)};
      export * from ${JSON.stringify(queue)};
      export function createInputQueue(deps) {
        const maker = createFakeMaker();
        return production({ ...deps, getMaker: () => maker,
          getTaskRuntimePlugins: () => undefined, admitLocalRoute: async () => undefined });
      }
    `,
  };
}

export async function createCredentialStore() {
  const { serializeAuthSessionRecord } = await import('@cindy/auth-client');
  const { AUTH_SESSION_KEY } = await import('../../../desktop/src/main/authCredentialKeys.ts');
  const records = new Map([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'fixture-refresh')]]);
  return { read: key => records.get(key) ?? null, write: (key, value) => records.set(key, value), remove: key => records.delete(key) };
}

export class SafeStorageUnavailableError extends Error {}

export async function hostAuthFetch(input) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const membership = { id: 'archived-input-owner', kind: 'personal', role: 'owner', displayName: 'Fixture',
    email: null, orgId: null, orgName: null };
  if (url.origin === 'https://fixture.invalid') {
    if (url.pathname === '/api/auth/refresh') return Response.json({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', membership });
    if (url.pathname === '/api/me') return Response.json({ membership, passportId: 'fixture-passport', identities: [membership] });
  }
  throw new Error('Unexpected authentication request in the archived input fixture');
}
