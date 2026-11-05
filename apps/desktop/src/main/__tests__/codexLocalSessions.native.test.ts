/**
 * #7436 native contract: production adoption/index repair -> real thread/resume
 * -> turn/start with imported history. Unit fixtures cannot enforce Codex's
 * filename/ordinal contract. Opt-in runtime tier, isolated homes + loopback model:
 * CINDY_CODEX_TEST_BINARY=<bundled binary> vitest run <this file>.
 * Separate from unit tests because this starts real processes and a local server.
 * Windows 0.159.2: 6.31s test body for all six native cases (runtime tier).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { AppServerHost } from '../../../../../packages/maker-core/src/agents/codex/app-server/host';
import { createStdioTransport } from '../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport';
import type { Logger } from '../../../../../packages/maker-core/src/interfaces/logger';
import { prepareExternalCodexSessionForResume, prepareCodexRolloutForResume } from '../maker-host/codex-local-sessions';
import { CodexThreadLocations } from '../maker-host/codex-thread-locations';

const fixture = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {} }) }));

const binary = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binary).each(['import', 'indexed', 'indexed-reverted', 'lineage', 'indexed-lineage', 'custom-lineage'] as const)(
  'resumes paginated history and completes the next native turn: %s', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-paginated-native-'));
    fixture.userData = path.join(root, 'cindy');
    const targetHome = path.join(fixture.userData, 'codex-home');
    const sourceHome = path.join(root, 'source');
    const hosts: AppServerHost[] = [];
    const oldHome = process.env.CODEX_HOME;
    const oldAppData = process.env.APPDATA;
    process.env.CODEX_HOME = sourceHome;
    process.env.APPDATA = path.join(root, 'appdata');
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(root);
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.end('{"models":[]}'); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_fixture', object: 'response', status: 'completed', model: 'gpt-5.4', output: [],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      } })}\n\n`);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      function host(home: string) {
        fs.mkdirSync(home, { recursive: true });
        const instance = new AppServerHost({ logger, clientInfo: { name: 'cindy-import-test', version: '1' },
          createTransport: () => createStdioTransport({ binaryPath: binary!, cwd: root,
            env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, CODEX_HOME: home,
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
            extraArgs: ['--disable', 'plugins', '--disable', 'remote_plugin',
              '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'model_provider="probe"',
              '-c', 'model_providers.probe.name="Probe"', '-c', `model_providers.probe.base_url=${JSON.stringify(baseUrl)}`,
              '-c', 'model_providers.probe.wire_api="responses"', '-c', 'model_providers.probe.requires_openai_auth=false',
              '-c', 'model_providers.probe.supports_websockets=false',
              '-c', 'model_providers.probe.request_max_retries=0', '-c', 'model_providers.probe.stream_max_retries=0'],
          }),
        });
        hosts.push(instance);
        return instance;
      }
      const id = randomUUID();
      const hasLineage = mode.includes('lineage');
      const ancestors: Array<{ file: string; contents: string; marker: string }> = [];
      let base: { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number } | undefined;
      // Two generations, including an archived independent rollout ID and an
      // earlier page of this same thread. Root-only fixtures missed #7436 lineage.
      if (hasLineage) {
        for (const archived of [false, true]) {
          const parentThread = archived ? randomUUID() : id;
          const rolloutId = archived ? randomUUID() : parentThread;
          const parentName = `rollout-2026-10-13T10-13-41-${parentThread}${archived ? `_${rolloutId}` : ''}.jsonl`;
          const file = path.join(sourceHome, archived ? 'archived_sessions' : 'sessions', '2026', '10', '13', parentName);
          const parentMarker = `ancestor-history-${rolloutId}`;
          const ordinal = base?.end_ordinal_exclusive ?? 0;
          const contents = [
            { ordinal, type: 'session_meta', payload: { id: parentThread, timestamp: '2026-10-13T10:13:41Z', cwd: root,
              originator: 'cindy-import-test', cli_version: '0.159.2', source: 'cli', history_mode: 'paginated',
              model_provider: 'probe', ...(base ? { history_base: base } : {}) } },
            { ordinal: ordinal + 1, type: 'response_item', payload: { type: 'message', role: 'user',
              content: [{ type: 'input_text', text: parentMarker }] } },
          ].map(item => JSON.stringify({ timestamp: '2026-10-13T10:13:41Z', ...item })).join('\n') + '\n';
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, contents);
          ancestors.push({ file, contents, marker: parentMarker });
          base = { thread_id: rolloutId, end_ordinal_exclusive: ordinal + 2, end_byte_offset: Buffer.byteLength(contents) };
        }
      }
      const filename = `rollout-2026-10-14T10-13-41-${id}${mode === 'indexed-reverted' || hasLineage ? `_${randomUUID()}` : ''}.jsonl`;
      const sourcePath = path.join(sourceHome, 'sessions', '2026', '10', '14', filename);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      const marker = `imported-history-${id}`;
      fs.writeFileSync(sourcePath, [
        { ordinal: base?.end_ordinal_exclusive ?? 0, type: 'session_meta', payload: { id, timestamp: '2026-10-14T10:13:41Z', cwd: root,
          originator: 'cindy-import-test', cli_version: '0.159.2', source: 'cli', history_mode: 'paginated', model_provider: 'probe',
          ...(base ? { history_base: base } : {}) } },
        { ordinal: (base?.end_ordinal_exclusive ?? 0) + 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] } },
      ].map(item => JSON.stringify({ timestamp: '2026-10-14T10:13:41Z', ...item })).join('\n') + '\n');
      const resume = { threadId: id, cwd: root, model: 'gpt-5.4', modelProvider: 'probe', approvalPolicy: 'never', sandbox: 'read-only' };
      const sourceHost = host(sourceHome);
      await sourceHost.request('thread/resume', { ...resume, path: sourcePath });
      await sourceHost.retire('source fixture complete');
      const original = fs.readFileSync(sourcePath, 'utf8');
      const target = host(targetHome);
      await target.ensureStarted();
      // Initialize the native schema without sending a model request.
      await target.request('thread/start', { cwd: root, model: 'gpt-5.4', modelProvider: 'probe', ephemeral: true });
      if (mode === 'custom-lineage') {
        // Existing state can reference history outside every discovery candidate.
        process.env.CODEX_HOME = path.join(root, 'unrelated-home');
        const sourceDbName = fs.readdirSync(sourceHome).find(name => /^state_\d+\.sqlite$/.test(name))!;
        const targetDbName = fs.readdirSync(targetHome).find(name => /^state_\d+\.sqlite$/.test(name))!;
        const sourceDb = new Database(path.join(sourceHome, sourceDbName), { readonly: true });
        const targetDb = new Database(path.join(targetHome, targetDbName));
        try {
          const row = sourceDb.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown>;
          const columns = Object.keys(row);
          targetDb.prepare(`INSERT INTO threads (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
        } finally { sourceDb.close(); targetDb.close(); }
      }
      let prepared = await prepareExternalCodexSessionForResume(id);
      expect(path.basename(prepared!)).toBe(filename);
      if (mode.startsWith('indexed')) {
        // Simulate an already-imported child from the old version, without ancestors.
        for (const ancestor of ancestors) fs.rmSync(path.join(targetHome, path.relative(sourceHome, ancestor.file)), { force: true });
        // Windows' old extended-path fallback flattened the selected file here.
        const broken = path.join(targetHome, 'sessions', `rollout-cindy-adopted-3-${filename}`);
        // Recreate an old release's sole selected path and index.
        fs.renameSync(prepared!, broken);
        expect(fs.existsSync(prepared!)).toBe(false);
        const dbName = fs.readdirSync(targetHome).filter(name => /^state_\d+\.sqlite$/.test(name)).sort().at(-1)!;
        const db = new Database(path.join(targetHome, dbName));
        try { db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(broken, id); }
        finally { db.close(); }
        const locations = new CodexThreadLocations(path.join(root, 'locations'), prepareCodexRolloutForResume);
        await locations.record(id, broken, targetHome);
        await expect(target.request('thread/resume', { ...resume, path: broken })).rejects.toThrow('canonical rollout filename');
        const storage = await locations.readStorage(id, { home: targetHome, prepare: prepareExternalCodexSessionForResume });
        prepared = storage!.rolloutPath;
        expect(await locations.prepareResume(id, prepareExternalCodexSessionForResume)).toBe(prepared);
      }
      const result = await target.request<{ thread: { id: string } }>('thread/resume', { ...resume, path: prepared });
      expect(result.thread.id).toBe(id);
      const completed = new Promise<string>(resolve => {
        target.subscribeThread(id, { turnCompleted: event => resolve(event.turn.status) });
      });
      await target.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Continue the imported task.' }] });
      expect(await completed).toBe('completed');
      expect(requests.some(body => body.includes(marker))).toBe(true);
      for (const ancestor of ancestors) {
        expect(requests.some(body => body.includes(ancestor.marker))).toBe(true);
        expect(fs.readFileSync(ancestor.file, 'utf8')).toBe(ancestor.contents);
        expect(fs.readFileSync(path.join(targetHome, path.relative(sourceHome, ancestor.file)), 'utf8')).toBe(ancestor.contents);
      }
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(original);
      expect(fs.readFileSync(prepared!, 'utf8')).toContain('Continue the imported task.');
    } finally {
      await Promise.all(hosts.map(instance => instance.retire('native import test finished')));
      await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
      homedir.mockRestore();
      if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000,
);
