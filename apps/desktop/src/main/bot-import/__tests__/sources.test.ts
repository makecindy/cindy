import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImportSourceReader, discoverImportSources, inspectImportSource } from '../sources.js';
import { transferCompanion, validateImportSelection, type TransferDeps } from '../transfer.js';
import { resolveImportReferences, selectedImportEnvironment } from '../environmentSelection.js';
import { discoverImportSkills, readImportSkillTree } from '../skills.js';
import { createImportBudget } from '../files.js';
import { indexAutomationDependencies, normalizeAutomation } from '../sourceAutomations.js';
import type { ImportItem, ImportSource } from '../types.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-source-test-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
async function write(name: string, text: string) { const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
const deps = () => ({ home, env: {}, readCronDatabase: vi.fn(async () => []) });

it.each(['hermes', 'openclaw'] as const)('previews 20,000 %s jobs with complete shared dependencies', async kind => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, JSON.stringify({
    mcpServers: { data: { url: 'https://example.invalid/mcp' } },
  }));
  await write(`.${kind}/.env`, 'API_TOKEN=fixture-token');
  const jobs = Array.from({ length: 20_000 }, (_, index) => ({ id: `job-${index}`, agentId: 'main',
    prompt: 'Use data with API_TOKEN', payload: { kind: 'agentTurn', message: 'Use data with API_TOKEN' },
    schedule: { kind: 'interval', minutes: 5 }, enabled: index % 2 === 0 }));
  await write(`.${kind}/cron/jobs.json`, JSON.stringify({ jobs }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const tasks = snapshot.items.filter(item => item.automation);
  const connection = snapshot.items.find(item => item.mcp?.name === 'data')!;
  const environment = snapshot.items.find(item => item.env?.API_TOKEN)!;
  expect(tasks).toHaveLength(jobs.length);
  expect(new Set(tasks.map(item => item.view.id)).size).toBe(jobs.length);
  expect(tasks.every((item, index) => item.view.enabled === jobs[index]!.enabled
    && item.view.dependsOn?.includes(connection.view.id) && item.view.dependsOn?.includes(environment.view.id)
    && item.automation?.input?.enabled === false)).toBe(true);
  expect(tasks.map(item => item.automation!.original)).toEqual(jobs);
});

it('indexes aliases and script subtrees while preserving dependency order and inherited policies', () => {
  const source: ImportSource = { kind: 'hermes', root: home, workspace: home, configFile: path.join(home, 'config.yaml'), agentId: 'main', name: 'Ada' };
  const view = (id: string, category: ImportItem['view']['category'] = 'connections') => ({ id, name: id, category, selected: true });
  const items: ImportItem[] = [
    { view: view('mcp'), mcp: { name: 'bridge', url: 'https://example.invalid/mcp' } },
    { view: { ...view('skill', 'skills'), name: 'Display name' }, sourceAlias: 'alias', sourceDirectory: path.join(home, 'folder'),
      files: [{ name: 'SKILL.md', bytes: Buffer.from('bridge SKILL_TOKEN'), executable: false }, { name: 'image.png', bytes: Buffer.from('UNUSED_TOKEN'), executable: false }] },
    { view: view('main'), asset: { name: 'scripts/reports/run.py', bytes: Buffer.from('SCRIPT_TOKEN') } },
    { view: view('data'), asset: { name: 'scripts/reports/data/check.py', bytes: Buffer.from('bridge') } },
    { view: view('unrelated'), asset: { name: 'scripts/reports-other/other.py', bytes: Buffer.from('UNUSED_TOKEN') } },
    { view: view('env'), env: { SKILL_TOKEN: 'a', SCRIPT_TOKEN: 'b', UNUSED_TOKEN: 'c' } },
    { view: view('tools'), credential: { format: 'source-tools', value: {} } },
    { view: view('model'), credential: { format: 'source-model', value: {} } },
  ];
  const dependencies = indexAutomationDependencies(items);
  const item = normalizeAutomation(source, { id: 'report', skills: ['folder', 'alias'], script: 'reports/run.py', monitor_script: 'reports/data/check.py', schedule: { kind: 'interval', minutes: 5 } }, dependencies, 'UTC');
  expect(item.view.dependsOn).toEqual(['mcp', 'skill', 'main', 'data']);
  expect(item.envDependencies?.names).toEqual(['SKILL_TOKEN', 'SCRIPT_TOKEN']);
  expect(item.view.issues).toEqual(['SOURCE_TOOL_POLICY_NEEDS_MAPPING', 'AUTOMATION_MODEL_NEEDS_MAPPING']);
  expect(normalizeAutomation(source, { id: 'missing', script: 'reports/missing.py' }, dependencies, 'UTC').view.issues).toContain('AUTOMATION_SCRIPT_MISSING');
});

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

it('retains an over-budget skill for retry without dropping healthy siblings', async () => {
  await write('.hermes/config.yaml', 'name: Ada\n');
  for (const name of ['first', 'second']) {
    await write(`.hermes/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\nRead data.txt`);
    await write(`.hermes/skills/${name}/data.txt`, 'x'.repeat(2048));
  }
  const jobs = (skills: string[]) => JSON.stringify([{ id: 'read', skills, prompt: 'Read resources', schedule: { kind: 'interval', minutes: 5 } }]);
  await write('.hermes/cron/jobs.json', jobs(['first']));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader, createImportBudget(6000));
  expect(snapshot.items.find(item => item.view.name === 'first')?.files?.find(file => file.name === 'data.txt')?.bytes.length).toBe(2048);
  expect(snapshot.items.find(item => item.view.name === 'second')?.files).toHaveLength(1);
  await write('.hermes/cron/jobs.json', jobs(['first', 'second']));
  const partial = await inspectImportSource(source!, reader, createImportBudget(6000));
  expect(partial.items.find(item => item.view.name === 'second')?.captureIssue).toBe('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(partial.items.find(item => item.view.name === 'first')?.files).toHaveLength(2);
});

it('counts configuration includes and memory against the same source budget', async () => {
  await write('.openclaw/openclaw.json', '{"$include":"extra.json"}');
  await write('.openclaw/extra.json', JSON.stringify({ name: 'x'.repeat(1000) }));
  await write('.openclaw/workspace/MEMORY.md', 'x'.repeat(1000));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const partial = await inspectImportSource(source!, reader, createImportBudget(2100));
  expect(partial.items.find(item => item.view.name === 'MEMORY.md')?.captureIssue).toBe('SOURCE_SNAPSHOT_TOO_LARGE');
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
  it('preserves personality and memory, defaults to all skills and resolves environment without shell evaluation', async () => {
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
    expect(result.items.find(item => item.view.name === 'unused')?.view.selected).toBe(true);
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

it('preserves every script while tracking only actual entry and monitor dependencies', async () => {
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
    'scripts/monitor/check.sh', 'scripts/monitor/data/value.txt', 'scripts/reports/daily.sh', 'scripts/reports/data/template.txt', 'scripts/reports/helper.sh', 'scripts/reports-unused/other.sh',
  ].sort());
  expect(automation.view.dependsOn?.toSorted()).toEqual(snapshot.items.filter(item => item.view.selected && (item.asset || item.env) && !item.asset?.name.includes('reports-unused')).map(item => item.view.id).sort());
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
  const metadata = createImportSourceReader(reader, createImportBudget(2350));
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

it('discovers 142 grouped Hermes skills and all memory documents, excluding archives and skill support folders', async () => {
  await write('.hermes/config.yaml', 'skills:\n  external_dirs: [../extra-skills]\n  disabled: [skill-1]\nheartbeat:\n  enabled: true\n');
  for (let i = 0; i < 142; i++) {
    await write(`.hermes/skills/group-${i % 13}/skill-${i}/SKILL.md`, `---\nname: skill-${i}\n---\nInstructions ${i}`);
  }
  for (let i = 0; i < 2100; i++) await write(`.hermes/memories/note-${i}.md`, `Memory ${i}`);
  await write('.hermes/skills/.archive/old/SKILL.md', 'archived');
  await write('.hermes/skills/group-0/skill-0/references/example/SKILL.md', 'example');
  await write('extra-skills/category/extra/SKILL.md', '---\nname: extra\n---\nExtra');
  await write('extra-skills/duplicate/SKILL.md', '---\nname: skill-0\n---\nShadow');
  await write('.hermes/cron/jobs.json', JSON.stringify([{ id: 'heartbeat-job', name: 'heartbeat-main', prompt: 'Check', schedule: { kind: 'interval', minutes: 5 } }]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skills = snapshot.items.filter(item => item.view.category === 'skills');
  expect(skills).toHaveLength(143);
  expect(skills.every(item => item.view.selected)).toBe(true);
  expect(skills.find(item => item.view.name === 'skill-1')?.view.enabled).toBe(false);
  expect(snapshot.items.filter(item => item.view.category === 'memory')).toHaveLength(2100);
  expect(snapshot.items.filter(item => item.automation).map(item => item.view.name)).toEqual(['heartbeat-main']);
  expect(validateImportSelection({ requestId: 'large-hermes-import', previewId: 'p', name: 'Ada', entryIds: snapshot.items.map(item => item.view.id), takeover: false }, snapshot)).toHaveLength(snapshot.items.length);
});

it('uses OpenClaw declared names, skillKey, grouped roots and plugin sources in native precedence order', async () => {
  await write('.openclaw/openclaw.json', JSON.stringify({ skills: { load: { extraDirs: ['../extra-skills'] }, entries: { 'auth-key': { enabled: false, env: { SERVICE_TOKEN: 'fixture-token' } } } }, plugins: { load: { paths: ['../my-plugin'] } } }));
  await write('.openclaw/workspace/skills/category/renamed/SKILL.md', '---\nname: report\nmetadata:\n  openclaw:\n    skillKey: auth-key\n---\nWorkspace');
  await write('.openclaw/skills/report/SKILL.md', '---\nname: report\n---\nShadow');
  await write('.openclaw/workspace/.agents/skills/project/SKILL.md', '# Project');
  await write('.agents/skills/personal/SKILL.md', '# Personal');
  await write('extra-skills/extra/SKILL.md', '# Extra');
  await write('my-plugin/openclaw.plugin.json', JSON.stringify({ id: 'sample', skills: ['skills'] }));
  await write('my-plugin/skills/example/SKILL.md', '# Plugin');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skills = snapshot.items.filter(item => item.view.category === 'skills');
  expect(skills.map(item => item.view.name)).toEqual(['report', 'project', 'personal', 'extra', 'example']);
  expect(skills[0]?.view).toMatchObject({ selected: true, enabled: false });
  expect(skills[0]?.files?.[0]?.bytes.toString()).toContain('Workspace');
  expect(snapshot.items.find(item => item.env?.SERVICE_TOKEN)?.view.selected).toBe(true);
});

it.for([
  { kind: 'hermes', folder: '.hermes/skills' },
  { kind: 'openclaw', folder: '.openclaw/skills' },
  { kind: 'openclaw', folder: '.agents/skills' },
] as const)('preserves native $folder directory links but bounds their resource subtree', async ({ kind, folder }, ctx) => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
  await write('shared/report/SKILL.md', '---\nname: report\n---\nRead report');
  await write('shared/report/scripts/report.py', '# Skill resource');
  await write('shared/report/.env', 'REPORT_MODE=fixture');
  await write('private/account.txt', 'Unrelated fixture');
  await fs.mkdir(path.join(home, folder), { recursive: true });
  try { await fs.symlink(path.join(home, 'shared/report'), path.join(home, folder, 'report'), 'junction'); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { ctx.skip(); return; } throw error; }
  await fs.symlink(path.join(home, folder), path.join(home, folder, 'loop'), 'junction');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skills = snapshot.items.filter(item => item.view.category === 'skills');
  expect(skills).toHaveLength(1);
  const directory = skills[0]!.sourceDirectory!;
  expect(directory).toBe(await fs.realpath(path.join(home, 'shared/report')));
  const resources = await readImportSkillTree(directory);
  expect(resources.map(file => file.name).sort()).toEqual(['.env', 'SKILL.md', 'scripts/report.py']);
  expect(resources.find(file => file.name === '.env')?.bytes.toString()).toBe('REPORT_MODE=fixture');
  // Trust in this Skill's canonical root does not grant its resources a second
  // escape into an unrelated directory, even when the Skill itself was linked.
  await fs.symlink(path.join(home, 'private'), path.join(directory, 'outside'), 'junction');
  await expect(readImportSkillTree(directory)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
});

it.for(['workspace/skills', 'workspace/.agents/skills', '../extra-skills'])(
  'requires native allowed targets for OpenClaw %s directory links', async (folder, ctx) => {
    await write('.openclaw/openclaw.json', '{}');
    await write('shared/report/SKILL.md', '---\nname: report\n---\nRead report');
    const sourceRoot = path.join(home, '.openclaw');
    const directory = path.resolve(sourceRoot, folder);
    await fs.mkdir(directory, { recursive: true });
    try { await fs.symlink(path.join(home, 'shared/report'), path.join(directory, 'report'), 'junction'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { ctx.skip(); return; } throw error; }
    const [source] = await discoverImportSources(deps());
    const inspect = (allowed: string[]) => discoverImportSkills(source!, {
      skills: { load: { extraDirs: ['../extra-skills'], allowSymlinkTargets: allowed } },
    }, home, {}, createImportBudget());
    expect(await inspect([])).toEqual([]);
    expect(await inspect(['../unrelated'])).toEqual([]);
    const allowed = await inspect(['../shared']);
    expect(allowed.map(item => item.view.name)).toEqual(['report']);
    expect(allowed[0]?.sourceDirectory).toBe(await fs.realpath(path.join(home, 'shared/report')));
  },
);

it('retains unmapped skill authentication privately without deselecting the skill', async () => {
  const secret = 'fixture-skill-key-without-env';
  await write('.openclaw/openclaw.json', JSON.stringify({ skills: { entries: { report: { apiKey: secret } } } }));
  await write('.openclaw/workspace/skills/report/SKILL.md', '---\nname: report\n---\nReport');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const skill = snapshot.items.find(item => item.view.category === 'skills')!;
  expect(skill.view).toMatchObject({ selected: true, issues: ['MISSING_ENVIRONMENT_REFERENCE'] });
  expect(skill.credential).toEqual({ format: 'source-skill-auth', value: { apiKey: secret } });
  expect(JSON.stringify(skill.view)).not.toContain(secret);
});

it.each(['hermes', 'openclaw'] as const)('records a failed %s memory subtree separately from a failed document', async kind => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
  const folder = kind === 'hermes' ? '.hermes/memories' : '.openclaw/workspace/memory';
  await write(`${folder}/healthy.md`, 'Keep healthy');
  await write(`${folder}/broken/note.md`, 'Repair directory');
  await write(`${folder}/bad.md`, 'Repair file');
  const open = fs.opendir.bind(fs);
  vi.spyOn(fs, 'opendir').mockImplementation(((...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]).endsWith(`${path.sep}broken`)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    return open(...args);
  }) as typeof fs.opendir);
  const read = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(((...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(`${path.sep}bad.md`)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    return read(...args);
  }) as typeof fs.open);
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  expect(snapshot.items.find(item => item.view.name === 'broken')?.sourceFile).toMatchObject({ root: path.join(home, folder), file: path.join(home, folder, 'broken'), kind: 'directory', logicalPrefix: kind === 'hermes' ? 'memories' : 'memory' });
  expect(snapshot.items.find(item => item.view.name === 'bad.md')?.sourceFile?.kind).toBe('file');
  expect(snapshot.items.find(item => item.view.name === 'healthy.md')?.text).toBe('Keep healthy');
});

it.each(['package.json', 'openclaw.plugin.json'])('bounds %s before allocating or parsing during skill discovery', async filename => {
  const directory = filename === 'package.json' ? 'bin/node_modules/openclaw' : 'plugin';
  const manifest = path.join(home, directory, filename);
  await write(`${directory}/${filename}`, '{}');
  await fs.truncate(manifest, 16 * 1024 * 1024 + 1);
  const source = { kind: 'openclaw' as const, agentId: 'main', name: 'Ada', root: path.join(home, '.openclaw'), workspace: path.join(home, '.openclaw/workspace'), configFile: path.join(home, '.openclaw/openclaw.json') };
  const config = { plugins: { load: { paths: [path.join(home, 'plugin')] } } };
  const env = { PATH: path.join(home, 'bin') };
  const allocate = vi.spyOn(Buffer, 'alloc');
  const parse = vi.spyOn(JSON, 'parse');
  await expect(discoverImportSkills(source, config, home, env, createImportBudget())).rejects.toThrow('SOURCE_FILE_TOO_LARGE');
  expect(allocate).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  allocate.mockRestore(); parse.mockRestore();
  await write(`${directory}/${filename}`, JSON.stringify(filename === 'package.json' ? { name: 'openclaw' } : { id: 'plugin', skills: ['skills'] }));
  await write(`${directory}/skills/report/SKILL.md`, '# Report');
  const skills = await discoverImportSkills(source, config, home, env, createImportBudget());
  expect(skills.map(item => item.view.name)).toEqual(['report']);
});

it('charges installed-package and plugin manifests to the same source budget before parsing the next one', async () => {
  await write('bin/node_modules/openclaw/package.json', JSON.stringify({ name: 'openclaw', padding: 'x'.repeat(600) }));
  await write('plugin/openclaw.plugin.json', JSON.stringify({ id: 'plugin', skills: ['skills'], padding: 'x'.repeat(600) }));
  const source = { kind: 'openclaw' as const, agentId: 'main', name: 'Ada', root: path.join(home, '.openclaw'), workspace: path.join(home, '.openclaw/workspace'), configFile: path.join(home, '.openclaw/openclaw.json') };
  const parse = vi.spyOn(JSON, 'parse');
  await expect(discoverImportSkills(source, { plugins: { load: { paths: [path.join(home, 'plugin')] } } }, home,
    { PATH: path.join(home, 'bin') }, createImportBudget(1500))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(parse).toHaveBeenCalledTimes(1);
});

it('preserves native manifest file symlinks while charging their contents', async ctx => {
  await write('shared/plugin.json', JSON.stringify({ id: 'plugin', skills: ['skills'] }));
  await write('plugin/skills/report/SKILL.md', '# Report');
  // Probe the actual filesystem capability, including Windows runners with
  // symlink support. Unsupported local permissions must not skip other cases.
  try { await fs.symlink(path.join(home, 'shared/plugin.json'), path.join(home, 'plugin/openclaw.plugin.json'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { ctx.skip(); return; }
    throw error;
  }
  const source = { kind: 'openclaw' as const, agentId: 'main', name: 'Ada', root: path.join(home, '.openclaw'), workspace: path.join(home, '.openclaw/workspace'), configFile: path.join(home, '.openclaw/openclaw.json') };
  const config = { plugins: { load: { paths: [path.join(home, 'plugin')] } } };
  expect((await discoverImportSkills(source, config, home, {}, createImportBudget())).map(item => item.view.name)).toEqual(['report']);
  await expect(discoverImportSkills(source, config, home, {}, createImportBudget(10))).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
});

it.each(['workspace', 'extraDirs', 'plugin', 'hermes'])('bounds empty %s directories during enumeration and closes the stream on budget failure', async location => {
  const root = path.join(home, location === 'hermes' ? '.hermes' : '.openclaw');
  const workspace = path.join(root, 'workspace');
  const directory = location === 'workspace' ? path.join(workspace, 'skills') : location === 'plugin' ? path.join(root, 'extensions') : location === 'extraDirs' ? path.join(home, 'extras') : path.join(root, 'skills');
  for (let index = 0; index < 40; index++) await fs.mkdir(path.join(directory, `empty-${index}`), { recursive: true });
  const source = { kind: location === 'hermes' ? 'hermes' as const : 'openclaw' as const, agentId: 'main', name: 'Ada', root, workspace, configFile: path.join(root, 'config.json') };
  const budget = createImportBudget(1500);
  const reserve = vi.spyOn(budget, 'reserve');
  const open = vi.spyOn(fs, 'opendir');
  const readdir = vi.spyOn(fs, 'readdir');
  await expect(discoverImportSkills(source, location === 'extraDirs' ? { skills: { load: { extraDirs: [directory] } } } : {}, home, {}, budget)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(readdir).not.toHaveBeenCalled();
  expect(reserve.mock.calls.length).toBeLessThan(40);
  const opened = open.mock.results.filter((_, index) => String(open.mock.calls[index]![0]) === directory);
  expect(opened).toHaveLength(1);
  const handle = await opened[0]!.value;
  await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
});

it('bounds native venv enumeration even when entries are not interpreter aliases', async () => {
  const directory = path.join(home, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await fs.mkdir(directory, { recursive: true });
  await write('.venv/pyvenv.cfg', `home = ${home}\n`);
  for (let index = 0; index < 40; index++) await fs.writeFile(path.join(directory, `ordinary-${index}`), '');
  const budget = createImportBudget(1500);
  const reserve = vi.spyOn(budget, 'reserve');
  const open = vi.spyOn(fs, 'opendir');
  const readdir = vi.spyOn(fs, 'readdir');
  await expect(readImportSkillTree(home, undefined, budget)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  expect(readdir).not.toHaveBeenCalled();
  expect(reserve.mock.calls.length).toBeLessThan(40);
  const opened = open.mock.results.filter((_, index) => String(open.mock.calls[index]![0]) === directory);
  expect(opened).toHaveLength(1);
  await expect((await opened[0]!.value).read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
});

it('preserves sorted skill-name precedence after streaming directory entries', async () => {
  await write('.hermes/skills/z-last/SKILL.md', '---\nname: report\n---\nLast');
  await write('.hermes/skills/a-first/SKILL.md', '---\nname: report\n---\nFirst');
  const root = path.join(home, '.hermes');
  const items = await discoverImportSkills({ kind: 'hermes', agentId: 'main', name: 'Ada', root, workspace: root, configFile: path.join(root, 'config.yaml') }, {}, home, {}, createImportBudget());
  expect(items).toHaveLength(1);
  expect(items[0]!.sourceAlias).toBe('a-first');
  expect(items[0]!.files![0]!.bytes.toString()).toContain('First');
});

it('does not synchronously sort a whole 100,000-entry Skill root before visiting children', async () => {
  const root = path.join(home, '.hermes'); const directory = path.join(root, 'skills');
  await fs.mkdir(directory, { recursive: true });
  const opendir = fs.opendir.bind(fs);
  let closed = false; let visited = 0; let previous = '';
  vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
    if (String(args[0]) !== directory) return opendir(...args);
    return { async *[Symbol.asyncIterator]() {
      try {
        for (let index = 99_999; index >= 0; index--) yield {
          name: `skill-${String(index).padStart(6, '0')}`,
          isDirectory: () => false, isSymbolicLink: () => true,
        };
      } finally { closed = true; }
    } } as Awaited<ReturnType<typeof fs.opendir>>;
  });
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    if (path.dirname(String(args[0])) !== directory) return stat(...args);
    const name = path.basename(String(args[0]));
    expect(previous.localeCompare(name)).toBeLessThan(0);
    previous = name; visited++;
    throw Object.assign(new Error('fixture dangling link'), { code: 'ENOENT' });
  });
  const sort = Array.prototype.sort;
  vi.spyOn(Array.prototype, 'sort').mockImplementation(function(this: unknown[], compare) {
    if (this.length > 8192) throw new Error('Unbounded synchronous directory sort');
    return sort.call(this, compare);
  });
  const items = await discoverImportSkills({ kind: 'hermes', agentId: 'main', name: 'Ada', root, workspace: root,
    configFile: path.join(root, 'config.yaml') }, {}, home, {}, createImportBudget());
  expect(items).toEqual([]);
  expect(visited).toBe(100_000);
  expect(closed).toBe(true);
}, 30_000);

it.each(['hermes', 'openclaw'] as const)('discovers %s custom archives, hidden TXT corpus and attachments without conflating roots', async kind => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
  const workspace = `.${kind}/${kind === 'hermes' ? '' : 'workspace/'}`;
  await write(`${workspace}memory/semantic/knowledge/note.md`, 'Custom archive');
  await write(`${workspace}memory/.dreams/session-corpus/session.txt`, 'Full transcript');
  await write(`${workspace}memory/picture.png`, '\0fixture image bytes');
  if (kind === 'hermes') await write('.hermes/memories/note.md', 'Built-in memory');
  else await write(`${workspace}DREAMS.md`, 'Dreams document');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const memory = snapshot.items.filter(item => item.view.category === 'memory');
  expect(memory.map(item => item.text)).toContain('Custom archive');
  expect(memory.map(item => item.text)).toContain('Full transcript');
  expect(memory.find(item => item.asset)?.asset?.bytes.toString()).toBe('\0fixture image bytes');
  expect(memory.map(item => item.text)).toContain(kind === 'hermes' ? 'Built-in memory' : 'Dreams document');
  expect(new Set(memory.map(item => item.view.id)).size).toBe(memory.length);
});


it.each(['hermes', 'openclaw'] as const)('imports %s textual state and backups without treating empty markers as attachments', async kind => {
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
  const folder = `.${kind}/${kind === 'hermes' ? 'memories' : 'workspace/memory'}`;
  const documents = { 'state.json': '{"lastRun":"fixture"}\n', 'MEMORY.md.bak-20260101': '# Old note\n', 'extensionless': 'A note\n', 'terminal.txt': 'A log with \u0015 control bytes\n' };
  for (const [name, text] of Object.entries(documents)) await write(`${folder}/${name}`, text);
  for (const name of ['.morning-report.sent', 'MEMORY.md.lock', 'empty.md']) await write(`${folder}/${name}`, '');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const memory = (await inspectImportSource(source!, reader)).items.filter(item => item.view.category === 'memory');
  expect(memory.filter(item => item.text).map(item => [item.view.name, item.text]).sort()).toEqual(Object.entries(documents).sort());
  expect(memory.filter(item => item.asset)).toHaveLength(3);
  expect(memory.filter(item => item.asset).every(item => item.asset!.bytes.length === 0)).toBe(true);
  expect(memory.every(item => !item.captureIssue)).toBe(true);
});

it('preserves native commands, heartbeat jobs and their instruction document', async () => {
  await write('.openclaw/openclaw.json', JSON.stringify({ agents: { defaults: { model: 'source-model' } }, tools: { profile: 'restricted' } }));
  await write('.openclaw/workspace/HEARTBEAT.md', 'Check the original checklist');
  const command = { kind: 'command', argv: ['node', 'report.js', 'argument with spaces'], cwd: home, timeoutSeconds: 90, noOutputTimeoutSeconds: 10, outputMaxBytes: 4096 };
  await write('.openclaw/cron/jobs.json', JSON.stringify({ jobs: [
    { id: 'command', name: 'Command report', payload: command, schedule: { kind: 'every', everyMs: 60000 } },
    { id: 'native-heartbeat', payload: { kind: 'heartbeat' }, schedule: { kind: 'every', everyMs: 60000 } },
    { id: 'ordinary-heartbeat', name: 'heartbeat-main', payload: { kind: 'agentTurn', message: 'A normal reminder' }, schedule: { kind: 'every', everyMs: 60000 } },
  ] }));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const inspected = await inspectImportSource(source!, reader);
  expect(inspected.items.find(item => item.view.name === 'HEARTBEAT.md')?.text).toBe('Check the original checklist');
  const tasks = inspected.items.filter(item => item.automation);
  expect(tasks).toHaveLength(3);
  expect(tasks[0]?.automation?.input).toMatchObject({ name: 'Command report', enabled: false });
  expect(tasks[0]?.automation?.original.payload).toEqual(command);
  expect(tasks[0]?.view.issues).toBeUndefined();
  expect(tasks[1]?.automation?.input).toMatchObject({ enabled: false, triggers: [{ kind: 'interval', intervalMs: 60000 }] });
  expect(tasks[1]?.automation?.original.payload).toEqual({ kind: 'heartbeat' });
  expect(tasks[1]?.view.issues).toContain('AUTOMATION_CONTEXT_NEEDS_MAPPING');
  expect(tasks[2]?.view.name).toBe('heartbeat-main');
});

for (const kind of ['hermes', 'openclaw'] as const) it(`imports ${kind} memory links only from its declared document vault`, async ctx => {
  const vault = path.join(home, 'vault');
  await write(`.${kind}/${kind === 'hermes' ? 'config.yaml' : 'openclaw.json'}`, '{}');
  await write(`.${kind}/.env`, `OBSIDIAN_VAULT_PATH=${vault}`);
  await write('vault/data/state.json', '{"cursor":7}');
  await write('private/auth.json', 'fixture-private-credential');
  const folder = path.join(home, `.${kind}/${kind === 'hermes' ? 'memories' : 'workspace/memory'}`);
  await fs.mkdir(folder, { recursive: true });
  try { await fs.symlink(path.join(vault, 'data/state.json'), path.join(folder, 'state.json'), 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
  await fs.symlink(path.join(home, 'private/auth.json'), path.join(folder, 'credentials.json'), 'file');
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const snapshot = await inspectImportSource(source!, reader);
  const memory = snapshot.items.filter(item => item.view.category === 'memory');
  expect(memory.find(item => item.view.name === 'state.json')?.text).toBe('{"cursor":7}');
  expect(memory.find(item => item.view.name === 'credentials.json')).toMatchObject({ captureIssue: 'SOURCE_LINK_OUTSIDE_FOLDER' });
  expect(JSON.stringify(snapshot)).not.toContain('fixture-private-credential');
  await fs.unlink(path.join(home, `.${kind}/.env`));
  const withoutDeclaration = await inspectImportSource(source!, { ...reader, env: { ...reader.env, OBSIDIAN_VAULT_PATH: vault } });
  expect(withoutDeclaration.items.find(item => item.view.name === 'state.json')).toMatchObject({ captureIssue: 'SOURCE_LINK_OUTSIDE_FOLDER' });
});

it('keeps distinct source records even when unsupported jobs lack usable identities', async () => {
  await write('.hermes/config.yaml', '{}');
  await write('.hermes/cron/jobs.json', JSON.stringify([
    { name: ' ', prompt: ' ', schedule: { kind: 'unknown' } },
    { name: ' ', prompt: ' ', schedule: { kind: 'unknown' } },
  ]));
  const reader = deps(); const [source] = await discoverImportSources(reader);
  const tasks = (await inspectImportSource(source!, reader)).items.filter(item => item.automation);
  expect(tasks).toHaveLength(2);
  expect(new Set(tasks.map(item => item.view.id)).size).toBe(2);
  expect(tasks.every(item => item.automation?.input?.enabled === false)).toBe(true);
});
