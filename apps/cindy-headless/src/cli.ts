#!/usr/bin/env node
import { capabilities, doctor, readProfile, type HeadlessProfile } from './profile.js';
import { runTask } from './host.js';
import { validateTurnInput } from './headless-integrations.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEvaluationReport, expandPairedPlan, expandPlan, expandScheduledPlan, freezeHard30, summarizePairedResults, validateManifest, validateOracleGate, validatePairedManifest, writePlan } from './benchmark.js';
import { capabilityCatalog, compatibilityReport, CINDY_HEADLESS_VERSION, CINDY_UPSTREAM_COMMIT, discoverCapabilityCatalog } from './compatibility.js';
import { generateProfileFromManifest } from './profile-generation.js';
import { applyGatewayConfig, loadGatewayConfig } from './gateway-config.js';
import { resolveHeadlessTimeout } from './defaults.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function requireFlag(name: string): string { const value = flag(name); if (!value) throw new Error(`${name} is required`); return value; }
function positiveNumberFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
function providerApiFlag(): 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai' | undefined {
  const value = flag('--api');
  if (value === undefined) return undefined;
  if (!['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'].includes(value)) throw new Error('--api is not supported');
  return value as 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
}
function effortFlag(): HeadlessProfile['model']['effort'] | undefined {
  const value = flag('--effort');
  if (value === undefined) return undefined;
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) throw new Error('--effort is not supported');
  return value as HeadlessProfile['model']['effort'];
}

async function main(): Promise<void> {
  if (command === 'doctor' || command === 'verify-agent' || command === 'run') {
    applyGatewayConfig(await loadGatewayConfig());
  }
  if (command === 'version') { console.log(JSON.stringify({ name: 'cindy-headless', version: CINDY_HEADLESS_VERSION, cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT, phase: 5, backends: ['claude-code', 'codex', 'pi'] })); return; }
  if (command === 'capabilities' && flag('--manifest')) {
    const manifest = JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')) as Record<string, unknown>;
    console.log(JSON.stringify(discoverCapabilityCatalog(manifest.capabilityCatalog), null, 2));
    return;
  }
  if (command === 'profile' && args[1] === 'generate') {
    const manifestPath = requireFlag('--manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const output = requireFlag('--output');
    const mcpConfigPath = flag('--mcp-config');
    const mcpServers = mcpConfigPath
      ? JSON.parse(await readFile(mcpConfigPath, 'utf8')) as HeadlessProfile['mcpServers']
      : undefined;
    if (mcpConfigPath && !Array.isArray(mcpServers)) throw new Error('--mcp-config must contain a JSON array');
    const profile = generateProfileFromManifest(manifest, {
      manifestPath,
      outputPath: output,
      harness: requireFlag('--harness'),
      features: (flag('--features') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      modelId: flag('--model'), providerId: flag('--provider'), providerName: flag('--provider-name'),
      providerBaseUrl: flag('--base-url'), providerApi: providerApiFlag(),
      apiKeyEnvVar: flag('--api-key-env-var'), contextLimit: positiveNumberFlag('--context-limit'),
      maxOutputTokens: positiveNumberFlag('--max-output-tokens'),
      mcpServers,
      effort: effortFlag(),
      gatewayModel: args.includes('--gateway-model'),
      exactFeatures: args.includes('--exact-features'),
    });
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(profile, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: true, profile, output }, null, 2));
    return;
  }
  if (command === 'doctor' || command === 'verify-agent' || command === 'compatibility-report' || command === 'capabilities' || command === 'profile') {
    if (command === 'profile' && args[1] !== 'validate') throw new Error('usage: profile validate --profile <file> or profile generate --manifest <file> --harness <name> --output <file>');
    const resolved = await readProfile(requireFlag('--profile'), flag('--bundle-dir'));
    if (command === 'capabilities') console.log(JSON.stringify({ ...capabilities(resolved.profile), capabilityCatalog: capabilityCatalog(resolved.profile.agentBackend), profileDigest: resolved.profileDigest, systemPromptDigest: resolved.systemPromptDigest }, null, 2));
    else if (command === 'compatibility-report') console.log(JSON.stringify({ ...compatibilityReport(resolved.profile), profileDigest: resolved.profileDigest, systemPromptDigest: resolved.systemPromptDigest }, null, 2));
    else if (command === 'doctor' || command === 'verify-agent') console.log(JSON.stringify(await doctor(resolved, flag('--output-dir')), null, 2));
    else console.log(JSON.stringify({ ok: true, profileId: resolved.profile.id, profileDigest: resolved.profileDigest, systemPromptDigest: resolved.systemPromptDigest }, null, 2));
    return;
  }
  if (command === 'run') {
    const task = flag('--task') ?? process.env.CINDY_HEADLESS_TASK ?? '';
    if (!task) throw new Error('--task or CINDY_HEADLESS_TASK is required');
    const turnsFile = flag('--turns-file');
    const turns = turnsFile ? JSON.parse(await readFile(turnsFile, 'utf8')) : [task];
    if (!Array.isArray(turns) || turns.length === 0) throw new Error('--turns-file must contain a non-empty turn array');
    turns.forEach(validateTurnInput);
    const timeout = resolveHeadlessTimeout(flag('--timeout-owner'), flag('--timeout-ms'));
    const result = await runTask(await readProfile(requireFlag('--profile'), flag('--bundle-dir')), task, flag('--working-dir') ?? process.cwd(), flag('--output-dir') ?? './results', timeout.timeoutMs, turns);
    console.log(JSON.stringify(result, null, 2));
    if (String(result.status ?? '').startsWith('infra-')) process.exitCode = 1;
    return;
  }
  if (command === 'plan') {
    const manifestPath = requireFlag('--manifest');
    const outputPath = requireFlag('--output');
    if (args.includes('--paired')) {
      const manifest = validatePairedManifest(validateManifest(JSON.parse(await readFile(manifestPath, 'utf8'))));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, JSON.stringify(expandPairedPlan(manifest), null, 2) + '\n', 'utf8');
    } else {
      const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, JSON.stringify(args.includes('--scheduled') ? expandScheduledPlan(manifest) : expandPlan(manifest), null, 2) + '\n');
    }
    console.log(JSON.stringify({ ok: true, output: requireFlag('--output') }));
    return;
  }
  if (command === 'paired-summary') {
    const results = JSON.parse(await readFile(requireFlag('--results'), 'utf8'));
    console.log(JSON.stringify(summarizePairedResults(results), null, 2));
    return;
  }
  if (command === 'report') {
    const manifest = validateManifest(JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')));
    const results = JSON.parse(await readFile(requireFlag('--results'), 'utf8'));
    console.log(JSON.stringify(createEvaluationReport(manifest, results), null, 2));
    return;
  }
  if (command === 'freeze-hard-30') {
    const historical = JSON.parse(await readFile(requireFlag('--historical'), 'utf8')) as Array<{ taskId: string; solveRate: number }>;
    console.log(JSON.stringify(freezeHard30(historical), null, 2));
    return;
  }
  if (command === 'oracle-gate') {
    const manifest = validateManifest(JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')));
    const results = JSON.parse(await readFile(requireFlag('--results'), 'utf8')) as Array<{ taskId: string; reward: number }>;
    console.log(JSON.stringify(validateOracleGate(manifest.dataset.taskIds, results), null, 2));
    return;
  }
  console.error('cindy-headless commands: version, doctor, verify-agent, compatibility-report, profile validate, capabilities [--manifest <bundle-manifest.json>], run [--turns-file] [--timeout-owner headless|external] [--timeout-ms N], plan [--paired|--scheduled], paired-summary, report, freeze-hard-30, oracle-gate');
  process.exitCode = 2;
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
