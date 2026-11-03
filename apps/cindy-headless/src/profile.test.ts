import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilities, profileDigest, readProfile, sha256, validateProfile } from './profile.js';
import { CINDY_UPSTREAM_COMMIT } from './compatibility.js';

const profile = { id: 'cindy-production-claude', version: 1, agentBackend: 'claude-code', agentBinaryPath: '/opt/cindy/bin/claude', agentBinaryVersion: '2.1.219', supportedModelIds: ['claude-sonnet-4-5'], model: { provider: 'anthropic', requestedId: 'claude-sonnet-4-5' }, permissionMode: 'bypassPermissions', makerMemory: false, nativeMemory: false, projectContext: false } as const;
const codexProfile = { ...profile, id: 'cindy-production-codex', agentBackend: 'codex', agentBinaryPath: '/opt/cindy/bin/codex', agentBinaryVersion: '0.145.0', supportedModelIds: ['gpt-5.4-mini'], model: { provider: 'openai', requestedId: 'gpt-5.4-mini' }, permissionMode: 'auto' } as const;
const piProfile = { ...profile, id: 'cindy-production-pi', agentBackend: 'pi', agentBinaryPath: '/opt/cindy/bin/pi', agentBinaryVersion: '0.83.0', model: { ...profile.model, contextLimit: 200_000 }, permissionMode: 'bypassPermissions' } as const;

describe('headless profile', () => {
  it('rejects model fallback and aliases', () => {
    expect(() => validateProfile({ ...profile, model: { ...profile.model, requestedId: 'other' } })).toThrow(/not supported/);
    expect(() => validateProfile({ ...profile, supportedModelIds: ['latest'], model: { ...profile.model, requestedId: 'latest' } })).toThrow(/exact/);
  });
  it('requires single-variable metadata for derived profiles', () => expect(() => validateProfile({ ...profile, parentProfile: 'base' })).toThrow(/changedDimensions/));
  it('keeps Cindy Maker Memory mutually exclusive with native memory for Claude and Codex', () => {
    expect(() => validateProfile({ ...profile, makerMemory: true, nativeMemory: true })).toThrow(/mutually exclusive/);
    expect(() => validateProfile({ ...codexProfile, makerMemory: true, nativeMemory: true })).toThrow(/mutually exclusive/);
  });
  it('allows Pi Maker Memory and Pi Auto Memory together like Cindy Desktop', () => {
    expect(validateProfile({ ...piProfile, makerMemory: true, nativeMemory: true })).toMatchObject({ makerMemory: true, nativeMemory: true });
  });
  it('reports the original Cindy harness switches in capabilities', () => expect(capabilities(validateProfile({ ...profile, makerMemory: true, projectContext: true }))).toMatchObject({ makerMemory: true, nativeMemory: false, projectContext: true, nativeToolSurface: 'claude-code-default', cindyMcpProviders: ['cindy_memory'], desktopOnlyProviders: [], multiTurnSession: true }));
  it('reports Cindy Codex app-server capabilities', () => expect(capabilities(validateProfile({ ...codexProfile, makerMemory: true }))).toMatchObject({ agentBackend: 'codex', nativeToolSurface: 'codex-app-server-default', supportedPermissionModes: ['bypassPermissions', 'ask', 'auto', 'plan'], cindyMcpProviders: ['cindy_memory'] }));
  it('reports Cindy Pi RPC capabilities', () => expect(capabilities(validateProfile({ ...piProfile, makerMemory: true }))).toMatchObject({ agentBackend: 'pi', nativeToolSurface: 'pi-rpc-default', supportedPermissionModes: ['bypassPermissions'], cindyMcpProviders: ['cindy_memory'] }));
  it('rejects backend-specific permission modes', () => {
    expect(() => validateProfile({ ...profile, permissionMode: 'auto' })).toThrow(/only supported by codex/);
    expect(() => validateProfile({ ...codexProfile, permissionMode: 'acceptEdits' })).toThrow(/not supported by codex/);
    expect(() => validateProfile({ ...piProfile, permissionMode: 'ask' })).toThrow(/no interactive approval channel/);
  });
  it('requires an explicit Pi context limit', () => expect(() => validateProfile({ ...piProfile, model: profile.model })).toThrow(/contextLimit/));
  it('accepts Cindy planning permission mode', () => expect(validateProfile({ ...profile, permissionMode: 'plan' }).permissionMode).toBe('plan'));
  it('requires unsafe bypass exceptions to be explicit and relevant', () => {
    expect(() => validateProfile({ ...profile, permissionMode: 'ask', unsafeAllowUnsandboxedBypass: true })).toThrow(/requires bypassPermissions/);
    expect(validateProfile({ ...profile, unsafeAllowUnsandboxedBypass: true }).unsafeAllowUnsandboxedBypass).toBe(true);
  });
  it('returns stable capabilities and canonical digest', () => {
    const valid = validateProfile(profile);
    expect(capabilities(valid).artifactContract).toEqual([
      'identity.json',
      'config.json',
      'trace.raw.jsonl',
      'trace.jsonl',
      'stderr.log',
      'usage.json',
      'result.json',
    ]);
    expect(profileDigest(valid)).toBe(profileDigest({ ...valid, supportedModelIds: [...valid.supportedModelIds] }));
  });
  it('accepts the no-compaction and tool-surface profile dimensions', () => {
    expect(validateProfile({ ...profile, parentProfile: 'cindy-production-claude', changedDimensions: ['compaction'], compaction: { enabled: false } }).compaction?.enabled).toBe(false);
    expect(validateProfile({ ...profile, parentProfile: 'cindy-production-claude', changedDimensions: ['cindyToolSurface'], makerMemory: false, projectContext: false }).projectContext).toBe(false);
  });
  it('verifies the system prompt digest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'headless-profile-'));
    await writeFile(path.join(dir, 'prompt.md'), 'prompt\n');
    await writeFile(path.join(dir, 'profile.json'), JSON.stringify({ ...profile, systemPromptFile: 'prompt.md', expectedSystemPromptDigest: '0'.repeat(64) }));
    await expect(readProfile(path.join(dir, 'profile.json'))).rejects.toThrow(/digest/);
  });
  it('validates explicit effort and output limits', () => {
    expect(validateProfile({ ...profile, model: { ...profile.model, effort: 'xhigh', maxOutputTokens: 32000 } }).model.effort).toBe('xhigh');
    expect(validateProfile({ ...profile, model: { ...profile.model, effort: 'ultra' } }).model.effort).toBe('ultra');
    expect(validateProfile({ ...piProfile, model: { ...piProfile.model, effort: 'minimal' } }).model.effort).toBe('minimal');
    expect(() => validateProfile({ ...piProfile, model: { ...piProfile.model, effort: 'ultra' } })).toThrow(/not supported by the pi backend/);
    expect(() => validateProfile({ ...profile, model: { ...profile.model, effort: 'unknown' as never } })).toThrow(/effort/);
    expect(() => validateProfile({ ...profile, model: { ...profile.model, maxOutputTokens: 0 } })).toThrow(/maxOutputTokens/);
    expect(() => validateProfile({ ...codexProfile, model: { ...codexProfile.model, maxOutputTokens: 32000 } })).toThrow(/not supported by the codex backend/);
  });
  it('enforces a colocated frozen profile lock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'headless-profile-lock-'));
    const raw = JSON.stringify(profile, null, 2);
    await writeFile(path.join(dir, 'profile.json'), raw);
    await writeFile(path.join(dir, 'profile.lock.json'), JSON.stringify({ schemaVersion: 1, status: 'frozen', profileId: profile.id, profileFile: 'profile.json', profileFileSha256: sha256(raw), profileDigest: profileDigest(validateProfile(profile)), systemPromptDigest: null, agentBinaryVersion: profile.agentBinaryVersion, cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT }));
    await expect(readProfile(path.join(dir, 'profile.json'))).resolves.toMatchObject({ profile: { id: profile.id } });
    await writeFile(path.join(dir, 'profile.json'), `${raw}\n`);
    await expect(readProfile(path.join(dir, 'profile.json'))).rejects.toThrow(/profile file/);
  });
  it('validates frozen attachment, MCP, BYOM, and Pi skill declarations', () => {
    expect(validateProfile({ ...profile, inputPolicy: { attachments: true, workspaceOnly: true }, mcpServers: [{ id: 'docs', transport: 'http', url: 'https://mcp.example.test', bearerTokenEnvVar: 'DOCS_TOKEN' }] }).mcpServers).toHaveLength(1);
    expect(() => validateProfile({ ...profile, mcpServers: [{ id: 'bad', transport: 'http', url: 'http://public.example.test' }] })).toThrow(/HTTPS/);
    expect(() => validateProfile({ ...profile, piProjectSkills: { enabled: true, roots: ['.agents/skills'] } })).toThrow(/pi backend/);
    const byom = validateProfile({ ...piProfile, model: { ...piProfile.model, provider: 'local' }, nativeProviders: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: [{ id: piProfile.model.requestedId, contextWindow: 200_000, maxTokens: 32_000 }] }], piProjectSkills: { enabled: true, roots: ['.pi/skills', '.agents/skills'] } });
    expect(capabilities(byom)).toMatchObject({ byomProviders: ['local'], piProjectSkills: true });
  });
  it('preserves the full DeepSeek model id through a neutral Pi gateway provider', async () => {
    const candidate = JSON.parse(await readFile(path.resolve('profiles/cindy-production-pi/profile.deepseek-v4-flash.example.json'), 'utf8'));
    const validated = validateProfile(candidate);
    expect(validated.model).toMatchObject({ provider: 'example-gateway', requestedId: 'deepseek/deepseek-v4-flash' });
    expect(validated.nativeProviders).toEqual([
      expect.objectContaining({
        id: 'example-gateway',
        api: 'openai-completions',
        models: [expect.objectContaining({ id: 'deepseek/deepseek-v4-flash' })],
      }),
    ]);
  });
  it('resolves a bundled binary relative to the profile file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'headless-profile-relative-'));
    await writeFile(path.join(dir, 'bin'), 'binary');
    await writeFile(path.join(dir, 'profile.json'), JSON.stringify({ ...profile, agentBinaryPath: 'bin' }));
    const resolved = await readProfile(path.join(dir, 'profile.json'));
    expect(resolved.profile.agentBinaryPath).toBe(path.join(dir, 'bin'));
  });
});
