/**
 * Opt-in live model evaluation of the three Desktop Host prompt profiles and
 * actual MCP tool schemas/handlers. Plugin/provider results are synthetic: this
 * never installs a plugin, stores a credential or authorizes a real account.
 * It does NOT launch the native harness binaries or test Anthropic caching.
 * pnpm exec tsx scripts/eval-plugin-authorization.mts --live --codex-home /path/to/codex --base <commit>
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCindyGhostsMcpServer } from '../packages/cindy-tools/src/ghost/mcpServer.js';
import type { CindyGhostsMcpDeps, CindyGhostInfo } from '../packages/cindy-tools/src/types.js';
import { appendPluginAuthorizationPrompt } from '../apps/desktop/src/main/plugin-oauth/prompt.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, 'codex-home': { type: 'string' }, base: { type: 'string' },
  model: { type: 'string', default: 'gpt-5.6-luna' },
} });
if (!values.live || !values['codex-home'] || !/^[a-f0-9]{40}$/.test(values.base ?? '')) {
  throw new Error('Explicit --live, --codex-home and full --base commit are required');
}
const repo = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), 'cindy-plugin-authorization-live-'));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const baseToolFile = 'packages/cindy-tools/src/ghost/mcpServer.ts';
const baselineTools = path.join(output, 'baseline-tools.mjs');
await build({
  stdin: { contents: execFileSync('git', ['show', `${values.base}:${baseToolFile}`], { cwd: repo, encoding: 'utf8' }),
    resolveDir: path.join(repo, path.dirname(baseToolFile)), loader: 'ts' },
  outfile: baselineTools, bundle: true, platform: 'node', format: 'esm',
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' },
});
const baselineFactory = (await import(pathToFileURL(baselineTools).href)).createCindyGhostsMcpServer as typeof createCindyGhostsMcpServer;
// Read only, in memory. No refresh/logout and no auth.json copied to the fixture.
const auth = JSON.parse(await readFile(path.join(values['codex-home'], 'auth.json'), 'utf8'));
if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('An existing OpenAI session is required');
const headers = { authorization: `Bearer ${auth.tokens.access_token}`, 'chatgpt-account-id': auth.tokens.account_id,
  'OpenAI-Beta': 'responses=experimental', originator: 'codex_cli_rs', accept: 'text/event-stream',
  'content-type': 'application/json' };

const cases = [
  { id: 'install', prompt: '请用 Demo Reports 查询我的报告数。当前没有安装插件，需要的话请安装相关插件并连接账号。' },
  { id: 'first-login', prompt: '请连接当前任务执行设备上的 demo-reports 插件账号，然后只读检查报告数。' },
  { id: 'reconfigure', prompt: '请更换 demo-reports 已保存的 API Key，重新打开配置卡。保存后只读检查报告数。' },
  { id: 'cancel', prompt: '请连接 demo-reports 插件，然后查询报告数。' },
  { id: 'unrelated', prompt: '计算 17 × 19。只回答数字。' },
  { id: 'unrelated-repeat', prompt: '计算 17 × 19。只回答数字。' },
];
const results: Record<string, any>[] = [];
const manifests: Record<string, any>[] = [];
let failedRequests = 0;
for (const profile of ['claude', 'codex', 'pi']) {
  const hostRoot = path.join(repo, 'apps/desktop/src/main/maker-host');
  const sections = ['host-system-prompt.md', ...(profile === 'pi' ? [] : ['skill-source-precedence-prompt.md']), `${profile}-system-prompt.md`];
  const original = (await Promise.all(sections.map(file => readFile(path.join(hostRoot, file), 'utf8'))))
    .map(section => section.trim()).filter(Boolean).join('\n\n');
  for (const variant of ['before', 'after'] as const) {
    const started = performance.now();
    let instructions = original;
    for (let i = 0; i < 10_000; i++) instructions = variant === 'after' ? appendPluginAuthorizationPrompt(original) : original;
    manifests.push({ profile, variant, bytes: Buffer.byteLength(instructions), sha256: sha(instructions),
      assemblyMicros: (performance.now() - started) * 1000 / 10_000,
      preservesPrefix: instructions.startsWith(original) });
    for (const sample of cases) {
      let installed = sample.id !== 'install', configured = sample.id === 'reconfigure', cancelled = false;
      const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
      const ghost = (): CindyGhostInfo => ({ id: 'demo-reports', name: 'Demo Reports', command: 'demo-reports',
        recall: 'Read report counts', tools: [{ name: 'count', description: 'Read the number of reports', parameters: { type: 'object', properties: {} } }],
        setup: { state: configured ? 'ready' : 'required', revision: 1, groups: [{ id: 'account', mode: 'any_of',
          items: [{ ref: 'secret:api_key', kind: 'secret', label: 'API Key', state: configured ? 'satisfied' : 'missing',
            actions: [{ id: 'inline_form:fixture', kind: 'inline_form', form: { fields: [{ id: 'value', type: 'secret', label: 'API Key', required: true, maxLength: 4096 }] } }] }] }] } });
      const deps = {
        listAwakeGhosts: async () => installed ? [ghost()] : [],
        getAwakeGhost: async (id: string) => installed && id === 'demo-reports' ? { ok: true, ghost: ghost() } :
          { ok: false, errorCode: 'GHOST_NOT_FOUND', message: 'Plugin not installed' },
        readGhostManual: async () => ({ ok: false, errorCode: 'MANUAL_UNAVAILABLE', message: 'No manual' }),
        searchMarket: async () => ({ ok: true, matches: [{ plugin_id: 'fixture-catalog/demo-reports', release_id: 'fixture-release-1', ghost_id: 'demo-reports', name: 'Demo Reports' }] }),
        installMarket: async ({ pluginId, releaseId }: { pluginId: string; releaseId: string }) => {
          if (pluginId !== 'fixture-catalog/demo-reports' || releaseId !== 'fixture-release-1') return { ok: false };
          installed = true; return { ok: true, ghost_id: 'demo-reports', status: 'installed' };
        },
        connectAccount: async () => {
          if (sample.id === 'cancel') { cancelled = true; return { ok: false, errorCode: 'SETUP_CANCELLED', message: 'User cancelled the card. Do not retry or run the plugin.' }; }
          configured = true; return { ok: true, status: 'ready', message: 'The card was submitted. Provider access still needs a read-only check.' };
        },
        callGhostTool: async () => cancelled ? { ok: false, errorCode: 'SETUP_CANCELLED', message: 'User cancelled' } :
          configured ? { ok: true, result: { count: 7 } } : { ok: false, errorCode: 'SETUP_REQUIRED', message: 'Use the Host setup card', setup: ghost().setup },
      } as CindyGhostsMcpDeps;
      const server = (variant === 'before' ? baselineFactory : createCindyGhostsMcpServer)(deps);
      const client = new Client({ name: 'plugin-authorization-eval', version: '1' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const tools = listed.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
        parameters: tool.inputSchema, strict: false }));
      const input: any[] = [{ role: 'user', content: sample.prompt }];
      const requests: any[] = [];
      let answer = '', error: string | undefined, complete = false;
      const turnStart = performance.now();
      try {
        for (let step = 0; step < 9; step++) {
          const started = performance.now();
          const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
            method: 'POST', headers, signal: AbortSignal.timeout(45_000),
            body: JSON.stringify({ model: values.model, instructions, input, tools, tool_choice: 'auto',
              store: false, stream: true, parallel_tool_calls: false, reasoning: { effort: 'low' },
              prompt_cache_key: `cindy-plugin-auth-${profile}-${variant}` }),
          });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let pending = '', doneResponse: any, firstEventMs: number | undefined;
          const eventTypes: string[] = [];
          const completedItems: any[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              const event = JSON.parse(line.slice(6));
              firstEventMs ??= performance.now() - started;
              if (eventTypes.at(-1) !== event.type) eventTypes.push(event.type);
              if (event.type === 'response.output_item.done') completedItems.push(event.item);
              if (event.type === 'response.completed') doneResponse = event.response;
              if (event.type === 'error' || event.type === 'response.failed') throw new Error('Provider stream failed');
            }
          }
          if (!doneResponse) throw new Error('Missing completed event');
          const usage = doneResponse.usage;
          requests.push({ durationMs: performance.now() - started, firstEventMs, eventTypes,
            inputTokens: usage?.input_tokens, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: usage?.output_tokens });
          // The subscription endpoint can omit output from its terminal summary.
          // Item events are authoritative; never discard the streamed tool calls.
          const items = (completedItems.length ? completedItems : doneResponse.output)
            .filter((item: any) => item.type !== 'reasoning');
          input.push(...items);
          const toolCalls = items.filter((item: any) => item.type === 'function_call');
          answer += items.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content)
            .filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('');
          if (!toolCalls.length) { complete = true; break; }
          for (const call of toolCalls) {
            const args = JSON.parse(call.arguments);
            calls.push({ name: call.name, arguments: args });
            const result = await client.callTool({ name: call.name, arguments: args });
            input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
          }
        }
      } catch (failure) {
        // Do not persist arbitrary fetch/SDK errors: they can contain headers.
        error = failure instanceof Error && /^HTTP \d+$/.test(failure.message) ? failure.message : 'Evaluation request failed';
      } finally { await client.close(); await server.close(); }
      const connections = calls.filter(call => call.name === 'connect_account');
      const countRead = calls.some(call => call.name === 'ghost_call' && call.arguments.tool === 'count');
      const pass = !error && complete && (sample.id.startsWith('unrelated') ? calls.length === 0 && answer.trim() === '323' :
        sample.id === 'cancel' ? connections.length === 1 && !countRead :
        sample.id === 'reconfigure' ? connections.some(call => call.arguments.reauthorize === true) && countRead :
        sample.id === 'install' ? calls.some(call => call.name === 'ghost_market_install') && connections.length === 1 && countRead :
        connections.length === 1 && countRead);
      results.push({ profile, variant, case: sample.id, pass, error, calls, answer, requests,
        toolsSha256: sha(JSON.stringify(tools)), durationMs: performance.now() - turnStart });
      await writeFile(path.join(output, 'results.json'), JSON.stringify({ base: values.base, model: values.model,
        environment: 'Live OpenAI model, actual MCP schemas/handlers, synthetic plugin state; Host prompt profiles, not native CLI sessions',
        manifests, results }, null, 2));
      console.log(JSON.stringify({ profile, variant, case: sample.id, pass, error, requests: requests.length }));
      failedRequests = error ? failedRequests + 1 : 0;
      if (error === 'HTTP 429' || failedRequests >= 3) throw new Error(`Live evaluation stopped; evidence: ${output}`);
    }
  }
}
console.log(JSON.stringify({ output, afterPassed: results.filter(row => row.variant === 'after' && row.pass).length,
  afterTotal: results.filter(row => row.variant === 'after').length }));
process.exitCode = results.some(row => row.variant === 'after' && !row.pass) ? 1 : 0;
