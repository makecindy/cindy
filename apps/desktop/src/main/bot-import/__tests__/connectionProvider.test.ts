import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
vi.mock('@cindy/mcps', () => ({ resolveLiziMcpSessionContext: () => ({ sessionId: 'fixture-session' }) }));
vi.mock('../host.js', () => ({ continueCompanionImport: vi.fn(), getCompanionImportSetupStatus: vi.fn(), useCindyImportSettings: vi.fn() }));
vi.mock('../runtime.js', () => ({ readCompanionSessionDiscovery: vi.fn(), readCompanionSessionEnvironment: vi.fn(), readCompanionSessionScope: vi.fn() }));
import { readCompanionSessionDiscovery, readCompanionSessionEnvironment, readCompanionSessionScope } from '../runtime.js';
import { projectEnvironmentDiscovery } from '../environmentJson.js';
import { createCompanionConnectionsProvider } from '../connectionProvider.js';
import { redactEnvironmentData } from '../process.js';
import { withImportedConnection } from '../connections.js';
import * as connectionModule from '../connections.js';
import { connectionRedactions, redactImportedTool, restoreImportedArguments } from '../connectionCatalog.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
let root: string | undefined;
beforeEach(() => {
  vi.mocked(readCompanionSessionDiscovery).mockReset().mockImplementation(async session => {
    const scope = await readCompanionSessionEnvironment(session);
    return scope ? { ...scope, environment: projectEnvironmentDiscovery(scope.environment) } : undefined;
  });
});
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });

it('lists and refreshes pending setup tools without loading the retry archive', async () => {
  vi.mocked(readCompanionSessionEnvironment).mockReset().mockRejectedValue(new Error('must not load full environment'));
  const assertOwner = vi.fn();
  vi.mocked(readCompanionSessionDiscovery).mockResolvedValue({ identity: 'fixture', botId: 'bot', userData: '/fixture', assertOwner,
    environment: { env: {}, mcp: [], identity: 'fixture', pendingImport: true } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    for (let i = 0; i < 3; i++) expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['run_command', 'import_setup']);
    expect(readCompanionSessionEnvironment).not.toHaveBeenCalled();
    expect(assertOwner).toHaveBeenCalled();
  } finally { await client.close(); await config.instance.close(); }
});

it.skipIf(process.platform === 'win32')('uses original credentials in a real imported command and redacts arbitrary names from its response', async () => {
  vi.stubEnv('CINDY_UNRELATED_TEST_SECRET', 'fixture-launch-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://fixture-user:fixture-password@example.invalid');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-command-test-'));
  const workspace = path.join(root, 'bots/bot/workspace');
  await fs.mkdir(path.join(workspace, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'scripts/report.sh'), 'printf workspace-report');
  const env = { GITHUB_PAT: 'fixture-pat', DATABASE_URL: 'postgres://fixture:secret@example.invalid/db', ALIAS: 'short' };
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'fixture', botId: 'bot', userData: root, assertOwner() {}, environment: { version: 1, env, mcp: [], credentials: [] } });
  const provider = createCompanionConnectionsProvider();
  const config = await provider.toClaudeSdkConfig!({} as never) as { type: string; instance: McpServer };
  if (config?.type !== 'sdk') throw new Error('Expected SDK bridge');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.some(tool => tool.name === 'run_command')).toBe(true);
    const result = await client.callTool({ name: 'run_command', arguments: { command: 'test -z "$CINDY_UNRELATED_TEST_SECRET" && test -z "$HTTPS_PROXY" && test "$ALIAS" = "short" && printf "authenticated %s %s %s" "$GITHUB_PAT" "$DATABASE_URL" "$ALIAS"' } });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain('authenticated');
    for (const value of Object.values(env)) expect(JSON.stringify(result)).not.toContain(value);
    expect(process.env.GITHUB_PAT).not.toBe(env.GITHUB_PAT);
    const relative = await client.callTool({ name: 'run_command', arguments: { command: 'sh scripts/report.sh > report.txt && cat report.txt' } });
    expect(relative.isError).toBe(false);
    expect(JSON.stringify(relative)).toContain('workspace-report');
    expect(await fs.readFile(path.join(workspace, 'report.txt'), 'utf8')).toBe('workspace-report');
    await expect(fs.access(path.join(root, 'bots/bot/report.txt'))).rejects.toThrow();
  } finally { await client.close(); await config.instance.close(); }
});

it('preserves structured numeric data while masking exact credentials under arbitrary names', () => {
  expect(redactEnvironmentData({ count: 1, value: '1', key: 'a+b', nested: ['x'] }, { arbitrary: 'a+b', code: '1', another: 'x' }))
    .toEqual({ count: 1, value: '[code]', key: '[arbitrary]', nested: ['[another]'] });
});

it('restores advertised enum, const, default and example values at the upstream call boundary', async () => {
  const env = { STAGE: 'prod', PRIVATE: 'fixture-private-key' };
  const connection = { name: 'stage', url: 'https://example.invalid/mcp' };
  const tool: Tool = { name: 'read_stage', inputSchema: { type: 'object', properties: {
    stage: { type: 'string', enum: ['prod', 'test'] },
    nested: { type: 'array', items: { type: 'object', properties: { fixed: { const: 'prod' }, fallback: { default: 'prefix-prod' }, note: { type: 'string' } } } },
    sample: { examples: [{ 'fixture-private-key': ['prod'] }] },
    free: { type: 'string' },
  } } };
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'schema-scalars', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    const properties = published.inputSchema.properties as { stage: { enum: string[] }; nested: { items: { properties: { fixed: { const: string }; fallback: { default: string } } } } };
    const nested = properties.nested.items.properties;
    expect(properties.stage.enum[0]).not.toBe('prod');
    expect(nested.fixed.const).not.toBe('prod');
    expect(nested.fallback.default).not.toBe('prefix-prod');
    const alias = properties.stage.enum[0]!;
    const sample = (published.inputSchema.properties!.sample as { examples: unknown[] }).examples[0];
    const args = { sample, stage: alias, nested: [{ fixed: nested.fixed.const, fallback: nested.fallback.default, note: alias }], free: alias, extra: '[PRIVATE]' };
    const result = await client.callTool({ name: published.name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith({ name: 'read_stage', arguments: { sample: { 'fixture-private-key': ['prod'] }, stage: 'prod', nested: [{ fixed: 'prod', fallback: 'prefix-prod', note: alias }], free: alias, extra: '[PRIVATE]' } }, undefined, { timeout: 120000 });
    expect(args.stage).toBe(properties.stage.enum[0]);
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it.each(['required', 'dependentRequired', 'dependencies', 'propertyNames.enum', 'propertyNames.const'] as const)('restores names declared only in %s at the corresponding argument path', async keyword => {
  const secret = 'fixture-required-field';
  const trigger = `trigger-${secret}`;
  const env = { PRIVATE: secret };
  const connection = { name: 'required-fields', url: 'https://example.invalid/mcp' };
  const propertyNames = keyword.startsWith('propertyNames.');
  const constraint = propertyNames ? { propertyNames: keyword === 'propertyNames.enum' ? { enum: [secret] } : { const: secret } }
    : keyword === 'required' ? { required: [secret] } : { [keyword]: { [trigger]: [secret] } };
  const tool: Tool = { name: 'read_fields', inputSchema: { type: 'object', properties: {
    group: { type: 'object', ...constraint }, untouched: { type: 'object' }, note: { type: 'string' },
  } } };
  const validateOriginal = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const callTool = vi.fn(async ({ arguments: args }) => ({ isError: !validateOriginal(args).valid, content: [{ type: 'text', text: 'ok' }] }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'required-fields', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    const group = published.inputSchema.properties!.group as Record<string, unknown>;
    const dependent = keyword === 'required' || propertyNames ? undefined : Object.entries(group[keyword] as Record<string, string[]>)[0]!;
    const nameSchema = group.propertyNames as { enum?: string[]; const?: string } | undefined;
    const alias = nameSchema ? (nameSchema.enum?.[0] ?? nameSchema.const)! : dependent ? dependent[1][0]! : (group.required as string[])[0]!;
    expect(alias).not.toContain(secret);
    if (dependent) expect(dependent[0]).not.toContain(secret);
    const publicFields = { [alias]: alias, ...(dependent ? { [dependent[0]]: 'on' } : {}) };
    const args = { group: publicFields, untouched: { ...publicFields }, note: alias };
    const before = structuredClone(args);
    expect(new AjvJsonSchemaValidator().getValidator(published.inputSchema)(args).valid).toBe(true);
    const result = await client.callTool({ name: published.name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith({ name: tool.name, arguments: {
      group: { [secret]: alias, ...(dependent ? { [trigger]: 'on' } : {}) }, untouched: publicFields, note: alias,
    } }, undefined, { timeout: 120000 });
    expect(args).toEqual(before);
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it.each(['if', 'then', 'else', 'not', 'dependentSchemas', 'dependencies'] as const)('restores aliases inside %s only at their declared argument path', async keyword => {
  const secret = 'fixture-conditional-key';
  const trigger = `trigger-${secret}`;
  const env = { PRIVATE: secret };
  const connection = { name: 'conditional-fields', url: 'https://example.invalid/mcp' };
  const constraint = { properties: { [secret]: { const: secret } }, required: [secret] };
  const dependency = keyword === 'dependentSchemas' || keyword === 'dependencies';
  const conditional = dependency ? { [keyword]: { [trigger]: constraint } }
    : keyword === 'not' ? { not: { ...constraint, required: [secret, 'mustBeAbsent'] } }
      : { ...(keyword === 'then' ? { if: true } : keyword === 'else' ? { if: false } : {}), [keyword]: constraint };
  const tool: Tool = { name: 'read_conditional', inputSchema: { type: 'object', properties: {
    rows: { type: 'array', items: { type: 'object', ...conditional, properties: { note: { type: 'string' } } } },
    untouched: { type: 'object' }, note: { type: 'string' },
  } } };
  const validateOriginal = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const callTool = vi.fn(async ({ arguments: args }) => ({ isError: !validateOriginal(args).valid, content: [{ type: 'text', text: 'ok' }] }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: `conditional-${keyword}`, botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    const item = (published.inputSchema.properties!.rows as { items: Record<string, unknown> }).items;
    const branches = item[keyword] as Record<string, unknown>;
    const publicTrigger = Object.keys(branches)[0]!;
    const branch = (dependency ? branches[publicTrigger] : branches) as { properties: Record<string, { const: string }> };
    const alias = Object.keys(branch.properties)[0]!;
    const literal = branch.properties[alias]!.const;
    expect(alias).not.toBe(secret); expect(literal).not.toBe(secret);
    const args = { rows: [{ [alias]: literal, note: literal, ...(dependency ? { [publicTrigger]: 'on' } : {}) }], untouched: { [alias]: literal }, note: literal };
    const before = structuredClone(args);
    expect(new AjvJsonSchemaValidator().getValidator(published.inputSchema)(args).valid).toBe(true);
    const result = await client.callTool({ name: published.name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith({ name: tool.name, arguments: {
      rows: [{ [secret]: secret, note: literal, ...(dependency ? { [trigger]: 'on' } : {}) }], untouched: { [alias]: literal }, note: literal,
    } }, undefined, { timeout: 120000 });
    expect(args).toEqual(before);
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it('preserves schema keywords while masking same-named properties and forwarding valid nested arguments', async () => {
  const env = Object.fromEntries(['properties', 'required', 'items', 'enum', 'type', 'additionalProperties', 'const'].map((value, index) => [`KEY_${index}`, value]));
  const connection = { name: 'schema', url: 'https://example.invalid/mcp' };
  const schema: Tool['inputSchema'] = { type: 'object', properties: {
    properties: { type: 'array', items: { type: 'object', properties: { required: { type: 'string', enum: ['enum'] } }, required: ['required'], additionalProperties: false } },
    type: { const: { properties: 'enum', type: 'ordinary value' } },
  }, required: ['properties', 'type'], additionalProperties: false };
  const tool: Tool = { name: 'read_schema', inputSchema: schema, outputSchema: schema };
  const original = structuredClone(tool);
  const callTool = vi.fn(async ({ arguments: args }) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: args }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'schema-keywords', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    const [arrayKey, literalKey] = published.inputSchema.required as string[];
    expect(arrayKey).not.toBe('properties'); expect(literalKey).not.toBe('type');
    const array = published.inputSchema.properties![arrayKey!] as { items: { properties: Record<string, { enum: string[] }>; required: string[]; additionalProperties: boolean } };
    const nestedKey = array.items.required[0]!;
    expect(nestedKey).not.toBe('required');
    expect(array.items.additionalProperties).toBe(false);
    const literal = (published.inputSchema.properties![literalKey!] as { const: Record<string, string> }).const;
    expect(literal).not.toHaveProperty('properties'); expect(literal).not.toHaveProperty('type');
    const args = { [arrayKey!]: [{ [nestedKey]: array.items.properties[nestedKey]!.enum[0] }], [literalKey!]: literal };
    const validate = new AjvJsonSchemaValidator().getValidator(published.inputSchema);
    expect(validate(args).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
    expect(validate({ ...args, [arrayKey!]: [{ [nestedKey]: 'wrong enum' }] }).valid).toBe(false);
    const result = await client.callTool({ name: published.name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(published.outputSchema).toEqual(published.inputSchema);
    expect(result.structuredContent).toEqual(args);
    expect(callTool).toHaveBeenCalledWith({ name: tool.name, arguments: { properties: [{ required: 'enum' }], type: { properties: 'enum', type: 'ordinary value' } } }, undefined, { timeout: 120000 });
    expect(tool).toEqual(original);
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it('refuses ambiguous scalar aliases and never expands arbitrary secret placeholders or schema descriptions', () => {
  expect(() => restoreImportedArguments({ stage: '[STAGE]' }, { enum: ['prod', '[STAGE]'] }, { STAGE: 'prod' })).toThrow('Ambiguous imported schema');
  expect(restoreImportedArguments({ value: '[PRIVATE]', enum: '[PRIVATE]' }, { properties: { enum: { description: 'key' } } }, { PRIVATE: 'key' })).toEqual({ value: '[PRIVATE]', enum: '[PRIVATE]' });
});

it('keeps literal and property aliases local through references, tuples and dictionary arguments', () => {
  const schema = { $defs: { mode: { enum: ['prod'] } }, properties: {
    rows: { items: { properties: { mode: { $ref: '#/$defs/mode' }, note: { type: 'string' } } } },
    tuple: { prefixItems: [{ const: 'prod' }, { type: 'string' }] },
    legacyTuple: { items: [{ default: 'prod' }, { type: 'string' }] },
    modes: { additionalProperties: { $ref: '#/$defs/mode' } },
    named: { propertyNames: { $ref: '#/$defs/mode' } },
    notes: { additionalProperties: { type: 'string' } },
    fixed: { const: { prod: 'prod', note: '[STAGE]' } },
  } };
  const args = { rows: [{ mode: '[STAGE]', note: '[STAGE]' }], tuple: ['[STAGE]', '[STAGE]'], legacyTuple: ['[STAGE]', '[STAGE]'],
    modes: { a: '[STAGE]' }, named: { '[STAGE]': '[STAGE]' }, notes: { '[STAGE]': '[STAGE]' }, fixed: { '[STAGE]': '[STAGE]', note: '[STAGE]' } };
  const original = structuredClone(args);
  expect(restoreImportedArguments(args, schema, { STAGE: 'prod' })).toEqual({
    rows: [{ mode: 'prod', note: '[STAGE]' }], tuple: ['prod', '[STAGE]'], legacyTuple: ['prod', '[STAGE]'],
    modes: { a: 'prod' }, named: { prod: '[STAGE]' }, notes: { '[STAGE]': '[STAGE]' }, fixed: { prod: 'prod', note: '[STAGE]' },
  });
  expect(args).toEqual(original);
});

it.each(['allOf', 'anyOf', 'oneOf'])('restores literals from %s at the declared path without changing sibling text', keyword => {
  expect(restoreImportedArguments({ mode: '[STAGE]', note: '[STAGE]' }, {
    properties: { mode: { [keyword]: [{ enum: ['prod'] }] }, note: { type: 'string' } },
  }, { STAGE: 'prod' })).toEqual({ mode: 'prod', note: '[STAGE]' });
});

it('preserves catalog enums and normal results with short locale variables, and forwards the selected enum unchanged', async () => {
  const env = { REGION: 'us', LANG: 'en', PRIVATE: 'fixture-secret-token' };
  const connection = { name: 'status', url: 'https://example.invalid/mcp' };
  const tool: Tool = { name: 'read_status', description: 'Read status in English', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['status', 'en', 'us'] } }, required: ['mode'] }, annotations: { readOnlyHint: true } };
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'status en us fixture-secret-token' }], structuredContent: { status: 'success', region: 'us', language: 'en' } }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'short-values', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    expect(published.inputSchema).toEqual(tool.inputSchema);
    expect(published.description).toContain('Read status in English');
    const result = await client.callTool({ name: published.name, arguments: { mode: 'status' } });
    expect(callTool).toHaveBeenCalledWith({ name: 'read_status', arguments: { mode: 'status' } }, undefined, { timeout: 120000 });
    expect(result.structuredContent).toEqual({ status: 'success', region: 'us', language: 'en' });
    expect(JSON.stringify(result)).not.toContain(env.PRIVATE);
    expect(JSON.stringify(result)).toContain('status en us');
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it.each([true, false])('preserves MCP response syntax and isError=%s when environment values collide with protocol names', async isError => {
  const wireNames = ['content', 'structuredContent', 'isError', '_meta', 'type', 'text', 'data', 'mimeType', 'resource', 'uri', 'annotations', 'audience', 'priority', 'user', 'icons', 'src', 'theme', 'dark'];
  const env = Object.fromEntries([...wireNames, 'fixture-private-token'].map((value, index) => [`SETTING_${index}`, value]));
  const connection = { name: 'fixture', url: 'https://example.invalid/mcp' };
  const tool: Tool = { name: 'read_result', inputSchema: { type: 'object' } };
  const payload = wireNames.join(' ') + ' fixture-private-token';
  const original = {
    content: [
      { type: 'text', text: payload, annotations: { audience: ['user'], priority: 0.5 }, _meta: { content: payload } },
      { type: 'image', data: 'AA==', mimeType: 'image/png' },
      { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file:///result', mimeType: 'text/plain', text: payload, _meta: { text: payload } } },
      { type: 'resource_link', name: 'report', uri: 'file:///report', description: payload, icons: [{ src: 'https://example.invalid/icon.png', theme: 'dark' }] },
    ],
    structuredContent: { content: payload, nested: { isError: 'fixture-private-token' }, count: 2 },
    isError, _meta: { content: payload }, 'fixture-private-token': payload,
  };
  const before = structuredClone(original);
  const callTool = vi.fn(async () => CallToolResultSchema.parse(original));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (_server, _env, _assert, run) => run({ listTools: async () => ({ tools: [tool] }), callTool } as never));
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'envelope-fixture', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const published = (await client.listTools()).tools[1]!;
    const result = CallToolResultSchema.parse(await client.callTool({ name: published.name, arguments: {} }));
    expect(result.isError).toBe(isError);
    expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'audio', 'resource', 'resource_link']);
    expect(result.content[0]).toMatchObject({ text: expect.any(String), annotations: { audience: ['user'], priority: 0.5 } });
    expect(result.content[1]).toMatchObject({ data: 'AA==', mimeType: 'image/png' });
    expect(result.content[2]).toMatchObject({ data: 'AA==', mimeType: 'audio/wav' });
    expect(result.content[3]).toMatchObject({ resource: { uri: 'file:///result', text: expect.any(String) } });
    expect(result.content[4]).toMatchObject({ icons: [{ src: 'https://example.invalid/icon.png', theme: 'dark' }] });
    expect(result.structuredContent).toMatchObject({ count: 2, nested: expect.any(Object) });
    expect(result.structuredContent).not.toHaveProperty('content');
    expect(result.structuredContent?.nested).not.toHaveProperty('isError');
    expect(result._meta).toBeDefined();
    expect(result._meta).not.toHaveProperty('content');
    for (const name of wireNames) expect(JSON.stringify([result.structuredContent, result._meta])).not.toContain(name);
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
    expect(original).toEqual(before);
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it('redacts resolved catalog credentials without changing schema syntax, tool dispatch or connection configuration', async () => {
  const env = { TOKEN: 'fixture-global-token', TYPE: 'object' };
  const basicUserinfo = 'alice:fixture-mcp-basic:password';
  const basicEncoded = Buffer.from(basicUserinfo).toString('base64');
  const connection = { name: 'fixture-server', url: 'https://fixture-user:fixture-password@example.invalid/mcp/fixture-path%2Ftoken?key=fixture-url-key#access_token=fixture%2Ffragment%2Bsecret',
    env: { TOKEN: 'fixture-local-token' }, headers: { Authorization: 'Bearer fixture-header-token', 'X-Api-Key': 'fixture-api-key',
      'Proxy-Authorization': `Basic ${basicEncoded}`,
      cOoKiE: 'session=fixture-cookie-session; alternate="fixture-cookie%2Fquoted=="; preference=dark' } };
  const secrets = [env.TOKEN, connection.env.TOKEN, connection.headers.Authorization, 'fixture-header-token', connection.headers['X-Api-Key'], connection.url, 'fixture-user', 'fixture-password', 'fixture-url-key', 'fixture-path%2Ftoken', 'fixture-path/token', 'fixture/fragment+secret', 'fixture%2Ffragment%2Bsecret',
    'fixture-cookie-session', 'fixture-cookie%2Fquoted==', 'fixture-cookie/quoted==', 'dark', basicUserinfo, basicEncoded, 'fixture-mcp-basic:password'];
  const echo = secrets.join(' ');
  const secretKey = 'argument_fixture-path/token';
  const tool: Tool = { name: `read_${connection.env.TOKEN}`, title: echo, description: echo,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: echo, default: echo }, count: { type: 'integer', minimum: 1 },
      nested: { type: 'array', items: { type: 'object', properties: { [secretKey]: { type: 'string' } }, required: [secretKey] } } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { result: { type: ['object', 'null'], description: echo, examples: [{ note: echo }] } } },
    annotations: { title: echo, readOnlyHint: true }, _meta: { debug: [echo], [secretKey]: 'private key name' } };
  const original = structuredClone({ tool, connection, env });
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: echo }], structuredContent: { rows: 2, [secretKey]: true } }));
  const imported = vi.spyOn(connectionModule, 'withImportedConnection').mockImplementation(async (server, environment, assert, run) => {
    expect(server).toEqual(original.connection); expect(environment).toEqual(original.env); assert();
    return run({ listTools: async () => ({ tools: [tool] }), callTool } as never);
  });
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'catalog-fixture', botId: 'bot', userData: '/fixture', assertOwner() {}, environment: { version: 1, env, mcp: [connection], credentials: [] } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(2);
    for (const secret of secrets) expect(JSON.stringify(catalog)).not.toContain(secret);
    const importedTool = catalog.tools[1]!;
    expect(importedTool.inputSchema).toMatchObject({ type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['query'], additionalProperties: false });
    expect(importedTool.outputSchema).toMatchObject({ type: 'object', properties: { result: { type: ['object', 'null'] } } });
    expect(importedTool.annotations?.readOnlyHint).toBe(true);
    const nested = importedTool.inputSchema.properties!.nested as { items: { properties: Record<string, unknown>; required: string[] } };
    const publicKey = Object.keys(nested.items.properties)[0]!;
    expect(nested.items.required).toEqual([publicKey]);
    const result = await client.callTool({ name: importedTool.name, arguments: { query: 'ordinary data', count: 2, nested: [{ [publicKey]: 'value' }] } });
    expect(callTool).toHaveBeenCalledWith({ name: tool.name, arguments: { query: 'ordinary data', count: 2, nested: [{ [secretKey]: 'value' }] } }, undefined, { timeout: 120000 });
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.structuredContent).toEqual({ rows: 2, [publicKey]: true });
    expect({ tool, connection, env }).toEqual(original);
    expect(redactImportedTool({ ...tool, name: 'ordinary_read' }, connectionRedactions(connection, env)).name).toBe('ordinary_read');
  } finally { imported.mockRestore(); await client.close(); await config.instance.close(); }
});

it('keeps healthy tools and commands available when another server is stopped or fails during pagination', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-catalog-test-'));
  await fs.mkdir(path.join(root, 'bots/bot'), { recursive: true });
  const file = path.join(root, 'server.cjs');
  await fs.writeFile(file, `const readline = require('node:readline');
const mode = process.argv[2];
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); if (!('id' in r)) return;
 if (mode === 'paged' && r.method === 'tools/list' && r.params.cursor) {
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'private upstream failure'}})+'\\n'); return;
 }
 const result=r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : r.method === 'tools/list' ? {tools:[{name:mode,inputSchema:{type:'object'}}],...(mode === 'paged' ? {nextCursor:'next'} : {})}
 : {content:[{type:'text',text:'healthy data'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
  const mcp = [
    { name: 'stopped', command: path.join(root, 'missing-server'), args: [] },
    { name: 'paged', command: process.execPath, args: [file, 'paged'] },
    { name: 'healthy', command: process.execPath, args: [file, 'healthy'] },
  ];
  const scope = { identity: root, botId: 'bot', userData: root, assertOwner() {}, environment: { version: 1 as const, env: {}, mcp, credentials: [] } };
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue(scope);
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools[0]?.name).toBe('run_command');
    expect(catalog.tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(catalog.tools[1]?.description).toContain('healthy');
    const result = await client.callTool({ name: catalog.tools[1]!.name, arguments: {} });
    expect(JSON.stringify(result)).toContain('healthy data');
    const command = await client.callTool({ name: 'run_command', arguments: { command: 'echo independent' } });
    expect(command.isError).toBe(false);
    expect(JSON.stringify(command)).toContain('independent');
    expect(JSON.stringify(catalog)).not.toContain('private upstream failure');
    scope.assertOwner = () => { throw new Error('OWNER_CHANGED'); };
    await expect(client.listTools()).rejects.toThrow('OWNER_CHANGED');
  } finally {
    await client.close(); await config.instance.close();
    // Dispose the cached healthy fixture process; failed catalogs already close theirs.
    await withImportedConnection(mcp[2]!, {}, () => {}, async () => { throw new Error('fixture cleanup'); }, { identity: scope.identity, signal: new AbortController().signal }).catch(() => {});
  }
});

it('offers paginated private import setup only in the owning companion and masks credential-bearing names', async () => {
  const { getCompanionImportSetupStatus, continueCompanionImport } = await import('../host.js');
  const secret = 'fixture-name-secret';
  const checks = Array.from({ length: 23 }, (_, index) => ({ entryId: `entry-${index}`, status: 'needs-attention' as const, message: 'IMPORT_SETUP_DEFERRED' }));
  const result = { requestId: 'fixture-request-setup', botId: 'bot', status: 'needs-attention' as const, checks, saved: true };
  vi.mocked(getCompanionImportSetupStatus).mockImplementation(async (_bot, _root, _assert, offset) => ({ status: result.status, total: 23, nextOffset: offset === 0 ? 20 : undefined, items: checks.slice(offset, offset + 20).map(check => ({ ...check, name: 'Job [API_KEY]' })) }));
  vi.mocked(continueCompanionImport).mockResolvedValue(result);
  const assertOwner = vi.fn();
  vi.mocked(readCompanionSessionScope).mockResolvedValue({ owner: 'fixture', botId: 'bot', userData: '/fixture', assertOwner });
  vi.mocked(readCompanionSessionEnvironment).mockResolvedValue({ identity: 'fixture', botId: 'bot', userData: '/fixture', assertOwner,
    environment: { version: 1, env: { API_KEY: secret }, mcp: [], credentials: [], pendingImport: {
      selection: { previewId: 'p', requestId: result.requestId, name: 'Ada', entryIds: [], takeover: true, deferSetup: true },
      snapshotJson: JSON.stringify({ source: {}, fingerprint: 'fixture', items: checks.map(check => ({ view: { id: check.entryId, name: `Job ${secret}`, category: 'automations', selected: true } })) }),
    } } });
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.some(tool => tool.name === 'import_setup')).toBe(true);
    vi.mocked(readCompanionSessionEnvironment).mockClear().mockRejectedValue(new Error('must not load full environment'));
    const first = await client.callTool({ name: 'import_setup', arguments: { operation: 'status' } });
    const text = (first.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ total: 23, nextOffset: 20 });
    expect(JSON.parse(text).items).toHaveLength(20);
    await client.callTool({ name: 'import_setup', arguments: { operation: 'retry', offset: 20 } });
    expect(continueCompanionImport).toHaveBeenCalledWith('bot', '/fixture', assertOwner);
    expect(getCompanionImportSetupStatus).toHaveBeenLastCalledWith('bot', '/fixture', assertOwner, 20);
    expect(readCompanionSessionEnvironment).not.toHaveBeenCalled();
    expect(assertOwner).toHaveBeenCalled();
  } finally { await client.close(); await config.instance.close(); }
});
