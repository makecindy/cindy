import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeCatalogModelPin } from '@cindy/model-providers/catalogModelPin';
import { TerminalModelConfig } from '../testing/model-config.js';
import { TerminalUtilityModels } from './utility.js';
import { TerminalSecretStore } from '../secrets.js';

export async function createUtilityFixture(cleanup: Array<() => Promise<unknown>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-utility-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const requests: string[] = [];
  const bodies: Array<{messages: Array<{role:string;content:string}>}> = [];
  let answer = 'UTILITY_OK';
  let intercept: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    bodies.push(input);
    requests.push(input.model);
    if (intercept) await intercept();
    if (res.destroyed) return;
    if (
      req.url !== '/models/chat/completions' ||
      req.headers.authorization !== 'Bearer fixture-secret' ||
      req.headers['x-fixture'] !== 'private-header'
    ) {
      res.writeHead(403).end('{}');
      return;
    }
    if (input.model === 'first') {
      res.writeHead(503).end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ choices: [{ message: { content: answer } }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const secrets = new TerminalSecretStore(root);
  await secrets.initialize('machine');
  const models = new TerminalModelConfig(root, secrets, async () => ({
    authenticated: false,
  }));
  await models.open();
  await models.saveProvider(
    {
      id: 'fixture',
      name: 'Fixture',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/models`,
          wireProtocol: 'openai-chat',
          headers: { 'x-fixture': 'private-header' },
          models: ['first', 'second'].map((id) => ({ id, name: id })),
        },
      },
    },
    { codex: 'fixture-secret' },
    true,
  );
  let active = true;
  const create = () => {
    const utility = new TerminalUtilityModels({
      root,
      models,
      log: { debug() {}, info() {}, warn() {} },
      assertCurrent: () => {
        if (!active) throw new Error('OWNER_CHANGED');
      },
      changed() {},
      native: {
        listAvailableAgents: () => [],
        getAgentAuthState: async () => ({ authenticated: false }),
        oneShot: async () => {
          throw new Error('NATIVE_DISPATCH_NOT_EXPECTED');
        },
      },
    });
    cleanup.push(() => utility.close());
    return utility;
  };
  const pin = (model: string) =>
    encodeCatalogModelPin({ providerId: 'fixture', agentKind: 'codex', model });
  return {
    root,
    models,
    requests,
    bodies,
    answer: (text: string) => { answer = text; },
    create,
    pin,
    revoke: () => {
      active = false;
    },
    intercept: (value: () => Promise<void>) => {
      intercept = value;
    },
  };
}
