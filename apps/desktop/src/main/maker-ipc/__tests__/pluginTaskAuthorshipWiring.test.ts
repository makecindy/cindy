import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('marks plugin dispatch and every queue fallback with the host-only receipt', () => {
  const start = source.indexOf('async function sendToSessionInternal(params: {');
  const end = source.indexOf('const startOrcaTeamForCaller', start);
  const dispatch = source.slice(start, end);
  expect(dispatch).toContain("message: text, autoReviewUserText: { kind: 'delegated-continuation' }, forceQueue: true");
  const queues = [...dispatch.matchAll(/await enqueueSendToSessionMessage\(\{([\s\S]*?)\}\);/g)];
  expect(queues).toHaveLength(4);
  for (const call of queues) expect(call[1]).toContain('autoReviewUserText: params.autoReviewUserText');
  // Both newly created and resumed direct tasks persist the same authored metadata.
  expect(dispatch.match(/agentMeta: inputAgentMeta/g)).toHaveLength(2);
});

it('keeps empty receipts distinct from missing authorship on direct persistence', () => {
  const start = source.indexOf('const inputAgentMeta: AgentMeta');
  const end = source.indexOf('    if (!message)', start);
  expect(start).toBeGreaterThan(0);
  const build = new Function('params', 'queuedOrigin', compile(source.slice(start, end) + '\nreturn inputAgentMeta;'));
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, undefined)).toEqual({ autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' });
  expect(build({}, undefined)).toBeUndefined();
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, { kind: 'orca' })).toMatchObject({ origin: { kind: 'orca' }, autoReviewUserText: { kind: 'delegated-continuation' } });
});

it('builds a durable queued plugin input without promoting plugin text to user intent', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  expect(start).toBeGreaterThan(0);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode,
    );
  const base = { targetSessionId: 'lead', clientId: 'plugin-input', message: 'Plugin instructions', persistedContent: 'Plugin instructions', meta: {} };
  const queued = JSON.parse(JSON.stringify(await build({ ...base, autoReviewUserText: { kind: 'delegated-continuation' } })));
  expect(queued).toMatchObject({ text: base.message, persistedContent: base.persistedContent, autoReviewUserText: { kind: 'delegated-continuation' }, permissionMode: 'auto' });
  expect(await build(base)).not.toHaveProperty('autoReviewUserText');
});
