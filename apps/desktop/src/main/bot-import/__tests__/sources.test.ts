import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImportSourceReader, discoverImportSources, inspectImportSource } from '../sources.js';
import { transferCompanion, validateImportSelection, type TransferDeps } from '../transfer.js';
import { resolveImportReferences, selectedImportEnvironment } from '../environmentSelection.js';
import { createImportBudget } from '../files.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-source-test-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
async function write(name: string, text: string) { const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
const deps = () => ({ home, env: {}, readCronDatabase: vi.fn(async () => []) });

it.each([
  { kind: 'hermes', config: { model: 'source-model' }, blocked: true },
  { kind: 'openclaw', config: { agents: { list: [{ id: 'main', model: 'source-model' }] } }, blocked: true },
  { kind: 'openclaw', config: { agents: { defaults: { model: { primary: 'source-model' } } } }, blocked: true },
  { kind: 'hermes', config: {}, blocked: false },
  { kind: 'openclaw', config: {}, blocked: false },
] as const)('preserves inherited $kind model semantics before takeover ($config)', async ({ kind, config, blocked }) => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, JSON.stringify(config));
  await write(`.${kind}/cron/jobs.json`, JSON.stringify({ jobs: [{ id: 'report', agentId: 'main', prompt: 'Report', payload: { message: 'Report' }, schedule: { kind: 'interval', minutes: 5 } }] }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const task = snapshot.items.find(item => item.automation)!;
  const transfer: TransferDeps = { assertOwner: vi.fn(), readReceipt: vi.fn(async () => undefined), saveReceipt: vi.fn(async () => {}),
    createCompanion: vi.fn(async () => {}), importItem: vi.fn(async () => {}), saveEnvironment: vi.fn(async () => {}), saveCheckpoint: vi.fn(async () => {}),
    createConversation: vi.fn(async () => 'chat'), createRoutine: vi.fn(async () => 'routine'),
    verifyAutomation: vi.fn(async () => ({ verified: true })), pauseSource: vi.fn(async () => {}), resumeSource: vi.fn(async () => {}), enableRoutine: vi.fn(async () => {}) };
  const result = await transferCompanion(snapshot, { requestId: 'fixture-model-request', previewId: 'preview', name: 'Ada', entryIds: snapshot.items.filter(item => item.view.selected).map(item => item.view.id), takeover: true }, transfer);
  expect(transfer.createRoutine).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ enabled: false }), expect.any(String), task);
  if (blocked) {
    expect(task.view.issues).toContain('AUTOMATION_MODEL_NEEDS_MAPPING');
    expect(result.checks.find(check => check.entryId === task.view.id)).toMatchObject({ status: 'needs-attention', message: 'AUTOMATION_MODEL_NEEDS_MAPPING' });
    expect(transfer.verifyAutomation).not.toHaveBeenCalled();
    expect(transfer.pauseSource).not.toHaveBeenCalled();
    expect(transfer.enableRoutine).not.toHaveBeenCalled();
  } else {
    expect(task.view.issues).toBeUndefined();
    expect(result.checks.find(check => check.entryId === task.view.id)?.status).toBe('taken-over');
    expect(transfer.pauseSource).toHaveBeenCalledOnce();
    expect(transfer.enableRoutine).toHaveBeenCalledOnce();
  }
});

it('shares one byte budget across referenced skill trees without truncating a snapshot', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  for (const name of ['first', 'second']) {
    await write(`.hermes/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\nRead data.txt`);
    await write(`.hermes/skills/${name}/data.txt`, 'x'.repeat(2048));
  }
  const jobs = (skills: string[]) => JSON.stringify([{ id: 'read', skills, prompt: 'Read resources', schedule: { kind: 'interval', minutes: 5 } }]);
  await write('.hermes/cron/jobs.json', jobs(['first']));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader, createImportBudget(3000));
  expect(snapshot.items.find(item => item.view.name === 'first')?.files?.find(file => file.name === 'data.txt')?.bytes.length).toBe(2048);
  expect(snapshot.items.find(item => item.view.name === 'second')?.files).toHaveLength(1);
  await write('.hermes/cron/jobs.json', jobs(['first', 'second']));
  await expect(inspectImportSource(source!, reader, createImportBudget(3000))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
});

it('counts configuration includes and memory against the same source budget', async () => {
  await write('.openclaw/openclaw.json', '{"$include":"extra.json"}');
  await write('.openclaw/extra.json', JSON.stringify({ name: 'x'.repeat(1000) }));
  await write('.openclaw/workspace/MEMORY.md', 'x'.repeat(1000));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  await expect(inspectImportSource(source!, reader, createImportBudget(1500))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
});

it.each([123, '', ' ', 'invalid\0path'])('rejects malformed stdio cwd %j before import', async cwd => {
  await write('.hermes/config.yaml', JSON.stringify({ mcpServers: { data: { command: 'node', args: ['./server.js'], cwd } } }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  await expect(inspectImportSource(source!, reader)).rejects.toThrow('SOURCE_CONFIG_INVALID');
});

it('retains cwd references and their selection dependency until import', async () => {
  await write('.hermes/config.yaml', JSON.stringify({ mcpServers: { data: { command: 'node', args: ['./server.js'], cwd: '${MCP_DIR}' } } }));
  await write('.hermes/.env', `MCP_DIR=${path.join(home, 'server files')}`);
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const server = snapshot.items.find(item => item.mcp)!;
  const variable = snapshot.items.find(item => item.env?.MCP_DIR)!;
  expect(server.mcp?.cwd).toBe('${MCP_DIR}');
  expect(server.view.dependsOn).toContain(variable.view.id);
  expect(JSON.stringify(server.view)).not.toContain(home);
});

describe('installed agent imports', () => {
  it.each(['hermes', 'openclaw'] as const)('resolves %s connection references only from the source environment', async kind => {
    const configPath = `.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`;
    const config = {
      mcpServers: { data: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } } },
      channels: { telegram: { botToken: '${TELEGRAM_TOKEN}' } },
    };
    await write(configPath, JSON.stringify(config));
    const reader = { ...deps(), env: { GITHUB_TOKEN: 'fixture-host-github-token', TELEGRAM_TOKEN: 'fixture-host-telegram-token' } };
    const [source] = await discoverImportSources(reader);
    const snapshot = await inspectImportSource(source!, reader);
    const env = selectedImportEnvironment(snapshot.items);
    expect(env).toEqual({});
    for (const value of Object.values(reader.env)) expect(JSON.stringify(snapshot)).not.toContain(value);
    const mcp = snapshot.items.find(item => item.mcp)!;
    const telegram = snapshot.items.find(item => item.credential?.format === 'telegram')!;
    for (const item of [mcp, telegram]) {
      expect(item.view.dependsOn).toHaveLength(1);
      expect(snapshot.items.some(provider => item.view.dependsOn!.includes(provider.view.id))).toBe(false);
      expect(() => resolveImportReferences(item.mcp ?? item.credential!.value, env)).toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
    }

    // A real source value still resolves, even if Cindy has a different value.
    await write(`.${kind}/.env`, 'GITHUB_TOKEN=fixture-source-github-token');
    await write(configPath, JSON.stringify({ ...config, env: { vars: { TELEGRAM_TOKEN: 'fixture-source-telegram-token' } } }));
    const configured = await inspectImportSource(source!, reader);
    const selected = configured.items.filter(item => item.view.selected);
    const sourceEnv = selectedImportEnvironment(selected);
    const connection = selected.find(item => item.mcp)!;
    const delivery = selected.find(item => item.credential?.format === 'telegram')!;
    expect(resolveImportReferences(connection.mcp, sourceEnv)).toMatchObject({ headers: { Authorization: 'Bearer fixture-source-github-token' } });
    expect(resolveImportReferences(delivery.credential!.value, sourceEnv)).toMatchObject({ token: 'fixture-source-telegram-token' });
    for (const item of [connection, delivery]) expect(item.view.dependsOn!.every(id => selected.some(provider => provider.view.id === id))).toBe(true);
    for (const value of Object.values(reader.env)) expect(JSON.stringify(configured)).not.toContain(value);
  });

  it.each(['hermes', 'openclaw'] as const)('retains selected %s source OAuth privately without turning it into runtime API credentials', async kind => {
    const profile = { provider: 'anthropic', type: 'oauth', access: 'fixture-source-oauth-access', refresh: 'fixture-source-oauth-refresh' };
    await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
    await write(kind === 'hermes' ? '.hermes/auth.json' : '.openclaw/agents/main/agent/auth-profiles.json', JSON.stringify(kind === 'hermes' ? { providers: { anthropic: profile } } : { profiles: { 'anthropic:source': profile } }));
    const reader = deps(); const [source] = await discoverImportSources(reader);
    const snapshot = await inspectImportSource(source!, reader);
    const credential = snapshot.items.find(item => item.credential?.format === 'native-auth')!;
    expect(credential.credential?.value).toMatchObject({ value: profile });
    expect(credential.view.selected).toBe(true);
    expect(credential.view.issues).toContain('NATIVE_AUTH_REFRESH_REQUIRED');
    expect(selectedImportEnvironment([credential])).toEqual({});
    for (const secret of [profile.access, profile.refresh]) expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain(secret);
    const selection = { requestId: 'fixture-oauth-request', previewId: 'preview', name: 'Ada', takeover: false, entryIds: [] };
    expect(validateImportSelection(selection, snapshot).some(item => item.credential)).toBe(false);
  });
  it('keeps secret references unexpanded until the final env and connection selection', async () => {
    await write('.hermes/config.yaml', 'name: Ada\nmcp_servers:\n  data:\n    url: https://example.invalid/mcp\n    headers:\n      Authorization: Bearer ${DATA_TOKEN}\n');
    await write('.hermes/.env', 'DATA_TOKEN=fake-selected-secret\nTELEGRAM_BOT_TOKEN=12345:fake-telegram-token');
    const reader = deps(); const [source] = await discoverImportSources(reader);
    const snapshot = await inspectImportSource(source!, reader);
    const mcp = snapshot.items.find(item => item.mcp)!;
    const token = snapshot.items.find(item => item.env?.DATA_TOKEN)!;
    expect(mcp.mcp?.headers?.Authorization).toBe('Bearer ${DATA_TOKEN}');
    expect(mcp.view.dependsOn).toContain(token.view.id);
    const telegram = snapshot.items.find(item => item.credential?.format === 'telegram')!;
    expect(telegram.credential?.value).toMatchObject({ token: '${TELEGRAM_BOT_TOKEN}' });
    expect(JSON.stringify(mcp)).not.toContain('fake-selected-secret');
    expect(JSON.stringify(telegram)).not.toContain('12345:fake-telegram-token');
  });
  it('preserves personality and memory, defaults to used skills and resolves environment without shell evaluation', async () => {
    await write('.hermes/config.yaml', 'name: Ada\n');
    await write('.hermes/SOUL.md', 'Calm, direct, and patient.');
    await write('.hermes/memories/USER.md', 'Prefers concise answers.');
    await write('.hermes/.env', 'DATA_API_KEY=not-a-real-secret-123\nDATA_URL=https://example.invalid/api\nLITERAL=$(never-run)');
    await write('.hermes/skills/report/SKILL.md', '---\nname: report\ndescription: Fetch DATA_URL using DATA_API_KEY\n---\nUse scripts/report.py');
    await write('.hermes/skills/report/scripts/report.py', 'print("fixture")');
    await write('.hermes/skills/unused/SKILL.md', '# unused');
    await write('.hermes/cron/jobs.json', JSON.stringify({ jobs: [{ id: 'daily', name: 'Report', prompt: 'Use report to read DATA_URL', skills: ['report'], schedule: { kind: 'interval', minutes: 5 }, enabled: true }] }));
    const reader = deps(); const sources = await discoverImportSources(reader);
    expect(sources).toHaveLength(1);
    const result = await inspectImportSource(sources[0]!, reader);
    expect(result.items.find(item => item.role === 'identity')?.text).toBe('Calm, direct, and patient.');
    expect(result.items.find(item => item.role === 'user')?.text).toContain('concise');
    expect(result.items.find(item => item.view.name === 'report')?.view.selected).toBe(true);
    expect(result.items.find(item => item.view.name === 'unused')?.view.selected).toBe(false);
    expect(result.items.find(item => item.env?.LITERAL)?.env?.LITERAL).toBe('$(never-run)');
    expect(JSON.stringify(result.items.map(item => item.view))).not.toContain('not-a-real-secret');
    const automation = result.items.find(item => item.automation)!;
    expect(automation.view.issues).toBeUndefined();
    expect(automation.automation?.input?.triggers).toEqual([{ id: 'time', kind: 'interval', intervalMs: 300000 }]);
    expect(automation.view.dependsOn).toContain(result.items.find(item => item.env?.DATA_API_KEY)!.view.id);
  });

  it('filters legacy OpenClaw tasks by selected agent and keeps paused tasks paused', async () => {
    await write('.openclaw/agents.json5', '{entries:[{id:"main",name:"Main",default:true},{id:"second",name:"Second"}]}');
    await write('.openclaw/openclaw.json', '{agents:{$include:"agents.json5"}}');
    await write('.openclaw/workspace-second/SOUL.md', 'Second persona');
    await write('.openclaw/cron/jobs.json', JSON.stringify({ jobs: [
      { id: 'a', agentId: 'main', name: 'Other', payload: { kind: 'agentTurn', message: 'Other reminder' }, schedule: { kind: 'every', everyMs: 60000 } },
      { id: 'b', agentId: 'second', name: 'Mine', enabled: false, payload: { kind: 'agentTurn', message: 'My reminder' }, schedule: { kind: 'every', everyMs: 120000, anchorMs: 100000 } },
    ] }));
    const reader = deps(); const sources = await discoverImportSources(reader);
    const source = sources.find(source => source.agentId === 'second')!;
    const snapshot = await inspectImportSource(source, reader);
    const tasks = snapshot.items.filter(item => item.automation);
    expect(tasks.map(item => item.view.name)).toEqual(['Mine']);
    expect(tasks[0]?.view.enabled).toBe(false);
    expect(tasks[0]?.automation?.input?.triggers[0]).toMatchObject({ kind: 'interval', anchorMs: 100000 });
  });

  it('uses the current SQLite source instead of stale JSON and never falls back on a DB failure', async () => {
    await write('.openclaw/openclaw.json', '{}');
    await write('.openclaw/state/openclaw.sqlite', 'fixture');
    await write('.openclaw/cron/jobs.json', '{"jobs":[]}');
    const reader = deps(); const [source] = await discoverImportSources(reader);
    reader.readCronDatabase.mockRejectedValue(new Error('unavailable'));
    await expect(inspectImportSource(source!, reader)).rejects.toThrow('unavailable');
    expect(reader.readCronDatabase).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main', defaultAgent: true }));
  });
});

it('imports Hermes context without turning unrelated repository instructions into personality', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/AGENTS.md', 'Only obey repository coding rules');
  await write('.hermes/CLAUDE.md', 'Project build instructions');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  expect((await inspectImportSource(source!, reader)).items.filter(item => item.role === 'instructions')).toEqual([]);
  await write('.hermes/HERMES.md', 'Speak gently and briefly.');
  expect((await inspectImportSource(source!, reader)).items.find(item => item.role === 'instructions')?.text).toBe('Speak gently and briefly.');
});

it('selects entry and monitor subtrees, including sibling code, resources and their environment dependencies', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/.env', 'DATA_URL=https://example.invalid\nDATA_TOKEN=fixture-token');
  await write('.hermes/scripts/reports/daily.sh', '. ./helper.sh');
  await write('.hermes/scripts/reports/helper.sh', 'curl -H "Authorization: Bearer $DATA_TOKEN" "$DATA_URL"');
  await write('.hermes/scripts/reports/data/template.txt', 'Daily report');
  await write('.hermes/scripts/monitor/check.sh', 'cat data/value.txt');
  await write('.hermes/scripts/monitor/data/value.txt', '7');
  await write('.hermes/scripts/reports-unused/other.sh', 'printf unrelated');
  await write('.hermes/cron/jobs.json', JSON.stringify([{ id: 'daily', script: path.join('reports', 'daily.sh'), monitor_script: path.join('monitor', 'check.sh'), no_agent: true, schedule: { kind: 'interval', minutes: 5 } }]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const automation = snapshot.items.find(item => item.automation)!;
  expect(automation.view.issues).toBeUndefined();
  const files = snapshot.items.filter(item => item.asset);
  expect(files.filter(item => item.view.selected).map(item => item.asset!.name).sort()).toEqual([
    'scripts/monitor/check.sh', 'scripts/monitor/data/value.txt', 'scripts/reports/daily.sh', 'scripts/reports/data/template.txt', 'scripts/reports/helper.sh',
  ]);
  expect(automation.view.dependsOn?.toSorted()).toEqual(snapshot.items.filter(item => item.view.selected && (item.asset || item.env)).map(item => item.view.id).sort());
  // A surviving sibling must not hide a missing entrypoint.
  await fs.unlink(path.join(home, '.hermes/scripts/reports/daily.sh'));
  expect((await inspectImportSource(source!, reader)).items.find(item => item.automation)?.view.issues).toContain('AUTOMATION_SCRIPT_MISSING');
});

it.each(['daily-report', 'Daily report'])('matches a skill reference %s against both its directory and display name', async reference => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  await write('.hermes/.env', 'REPORT_TOKEN=fixture-token\nREPORT_URL=https://example.invalid/api');
  await write('.hermes/skills/daily-report/SKILL.md', '---\nname: Daily report\n---\nUse scripts/query.py');
  await write('.hermes/skills/daily-report/scripts/query.py', 'print(os.environ["REPORT_TOKEN"], os.environ["REPORT_URL"])');
  await write('.hermes/cron/jobs.json', JSON.stringify([{ id: 'daily', prompt: 'Read my report', skills: [reference], schedule: { kind: 'interval', minutes: 5 } }]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skill = snapshot.items.find(item => item.view.category === 'skills')!;
  const automation = snapshot.items.find(item => item.automation)!;
  expect(skill.view.selected).toBe(true);
  expect(automation.view.dependsOn).toEqual(expect.arrayContaining([
    skill.view.id, ...snapshot.items.filter(item => item.env).map(item => item.view.id),
  ]));
  expect(skill.files?.find(file => file.name === 'scripts/query.py')).toBeDefined();
});

it('requires an explicit credential account and binds variables to the chosen profile, including MCP references', async () => {
  await write('.openclaw/openclaw.json', JSON.stringify({ mcpServers: { data: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${OPENAI_API_KEY}' } } } }));
  await write('.openclaw/agents/main/agent/auth-profiles.json', JSON.stringify({ profiles: {
    'openai:work': { provider: 'openai', type: 'api_key', key: 'fixture-work-key' },
    'openai:personal': { provider: 'openai', type: 'api_key', key: 'fixture-personal-key' },
  } }));
  await write('.openclaw/cron/jobs.json', JSON.stringify({ jobs: [{ id: 'report', agentId: 'main', payload: { message: 'Use data with OPENAI_API_KEY' }, schedule: { kind: 'every', everyMs: 60000 } }] }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const profiles = snapshot.items.filter(item => item.env?.OPENAI_API_KEY);
  expect(profiles).toHaveLength(2);
  expect(profiles.every(item => !item.view.selected)).toBe(true);
  expect(profiles[0]!.view.exclusiveWith).toEqual([profiles[1]!.view.id]);
  const defaults = snapshot.items.filter(item => item.view.selected).map(item => item.view.id);
  const selection = { requestId: 'fixture-credential-request', previewId: 'preview', name: 'Ada', takeover: true, entryIds: defaults };
  expect(() => validateImportSelection({ ...selection, entryIds: [...defaults, ...profiles.map(item => item.view.id)] }, snapshot)).toThrow('INVALID_SELECTION');
  for (const profile of profiles) {
    const selected = validateImportSelection({ ...selection, entryIds: [...defaults, profile.view.id] }, snapshot);
    expect(selectedImportEnvironment(selected).OPENAI_API_KEY).toBe(profile.env!.OPENAI_API_KEY);
    for (const consumer of selected.filter(item => item.mcp || item.automation)) {
      expect(consumer.view.dependsOn).toContain(profile.view.id);
      expect(consumer.view.dependsOn?.every(id => selected.some(item => item.view.id === id))).toBe(true);
      expect(consumer.view.issues).toBeUndefined();
    }
  }
  const missing = validateImportSelection(selection, snapshot).find(item => item.automation)!;
  expect(missing.view.dependsOn?.some(id => !defaults.includes(id))).toBe(true);
  expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain('fixture-work-key');
  expect(JSON.stringify(snapshot.items.map(item => item.view))).not.toContain('fixture-personal-key');
});

it('discovers masked names from cached credential metadata without reading SQLite, memory or skill resources', async () => {
  const secrets = ['fixture-env-token', 'fixture-header-token', 'fixture-skill-token', 'fixture-primary-key',
    'fixture-telegram-token', 'fixture-path-token', 'fixture-tool-key'];
  const agents = ['alpha', 'beta', 'gamma'].map(id => ({ id, name: `DEBUG true PORT 3000 ${secrets.join(' ')} fixture-auth-${id}` }));
  await write('.openclaw/openclaw.json', JSON.stringify({ $include: 'shared.json', agents: { list: agents } }));
  await write('.openclaw/shared.json', JSON.stringify({
    mcpServers: { data: { url: `https://example.invalid/mcp/${secrets[5]}`, headers: { Authorization: `Bearer ${secrets[1]}` } } },
    skills: { entries: { report: { env: { REPORT_TOKEN: secrets[2] }, apiKey: secrets[3] } } },
    channels: { telegram: { tokenFile: 'telegram-token.txt' } }, tools: { apiKey: secrets[6] },
  }));
  await write('.openclaw/.env', `KEY=${secrets[0]}\nDEBUG=true\nPORT=3000`);
  await write('.openclaw/telegram-token.txt', secrets[4]!);
  await write('.openclaw/state/openclaw.sqlite', 'locked database fixture');
  await write('.openclaw/workspace/MEMORY.md', 'memory must not be read');
  await write('.openclaw/skills/report/SKILL.md', '# report');
  await write('.openclaw/skills/report/data.txt', 'resource must not be read');
  for (const { id } of agents) await write(`.openclaw/agents/${id}/agent/auth-profiles.json`,
    JSON.stringify({ profiles: { openai: { type: 'api_key', key: `fixture-auth-${id}` } } }));
  const reader = deps();
  reader.readCronDatabase.mockRejectedValue(new Error('locked database'));
  const open = vi.spyOn(fs, 'open');
  const metadata = createImportSourceReader(reader);
  const sources = await discoverImportSources(reader, metadata);
  const readName = metadata.readName;
  for (const source of sources) {
    const name = await readName(source);
    expect(name).toContain('DEBUG true PORT 3000');
    for (const secret of [...secrets, `fixture-auth-${source.agentId}`]) expect(name).not.toContain(secret);
  }
  expect(reader.readCronDatabase).not.toHaveBeenCalled();
  const realHome = await fs.realpath(home);
  const opened = open.mock.calls.map(([file]) => path.relative(realHome, String(file)).split(path.sep).join('/'));
  expect(opened.sort()).toEqual([
    '.openclaw/.env', '.openclaw/openclaw.json', '.openclaw/shared.json', '.openclaw/telegram-token.txt',
    ...agents.map(({ id }) => `.openclaw/agents/${id}/agent/auth-profiles.json`),
  ].sort());
  // Cache belongs to this discovery request; later requests see changed keys.
  await write('.openclaw/.env', 'KEY=fixture-replaced-token');
  expect(await createImportSourceReader(reader).readName({ ...sources[0]!, name: 'Ada fixture-replaced-token' })).not.toContain('fixture-replaced-token');
});

it('bounds cumulative discovery metadata and refuses to publish a partially checked name', async () => {
  await write('.hermes/config.yaml', 'name: Ada');
  await write('.hermes/.env', `KEY=${'x'.repeat(70)}`);
  await write('.hermes/auth.json', JSON.stringify({ providers: { openai: { type: 'api_key', key: 'y'.repeat(70) } } }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const readName = createImportSourceReader(reader, createImportBudget(128)).readName;
  await expect(readName(source!)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  await expect(readName(source!)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
});

it('shares discovery config/include reads with name masking and charges all Hermes profiles to one budget', async () => {
  for (const id of ['a', 'b', 'c']) {
    await write(`.hermes/profiles/${id}/config.yaml`, `$include: included.yaml\nname: ${id}\n`);
    await write(`.hermes/profiles/${id}/included.yaml`, `model: ${'x'.repeat(60)}\n`);
    await write(`.hermes/profiles/${id}/.env`, `API_KEY=${'z'.repeat(80)}\n`);
  }
  const reader = deps();
  const metadata = createImportSourceReader(reader, createImportBudget(400));
  const opened = vi.spyOn(fs, 'open');
  const sources = await discoverImportSources(reader, metadata);
  expect(sources).toHaveLength(3);
  await metadata.readName(sources[0]!);
  await expect(metadata.readName(sources[1]!)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  for (const id of ['a', 'b', 'c']) for (const name of ['config.yaml', 'included.yaml']) {
    expect(opened.mock.calls.filter(([file]) => String(file).endsWith(path.join('profiles', id, name)))).toHaveLength(1);
  }
  expect(reader.readCronDatabase).not.toHaveBeenCalled();
});

it('enforces the default four MiB limit during discovery before masking names', async () => {
  for (let i = 0; i < 5; i++) await write(`.hermes/profiles/p${i}/config.yaml`, `name: p${i}\n#${'x'.repeat(1024 * 1024)}`);
  await expect(discoverImportSources(deps())).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
});

it('still rejects cycles across concurrent include branches with the shared parsed cache', async () => {
  await write('.hermes/config.yaml', 'rows:\n - $include: a.yaml\n - $include: b.yaml');
  await write('.hermes/a.yaml', '$include: b.yaml');
  await write('.hermes/b.yaml', '$include: a.yaml');
  await expect(discoverImportSources(deps())).rejects.toThrow('SOURCE_CONFIG_INCLUDE_CYCLE');
});
