import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildOfficialMacBundleVerificationArgs,
  checkCodexBrowserCompanionConnection,
  hasOfficialMacTeamIdentifier,
  OFFICIAL_MAC_BUNDLE_REQUIREMENT,
  prepareCodexBrowserCompanion,
  resolveCodexBrowserCompanionSpawnConfig,
} from '../codex-browser-companion.js';

const tempDirs: string[] = [];

async function setup(overrides: {
  command?: string;
  pluginEnabled?: boolean;
  isolatedPluginEnabled?: boolean;
  nodeReplEnabled?: boolean;
  includeExtensionHost?: boolean;
  extraEnv?: string;
  nodeReplContent?: string;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-companion-'));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(root, 'cindy-codex-home');
  const appBundle = path.join(root, 'ChatGPT.app');
  const resources = path.join(appBundle, 'Contents', 'Resources');
  const nodeRepl = overrides.command
    ?? path.join(resources, 'cua_node', 'bin', 'node_repl');
  const nodePath = path.join(resources, 'cua_node', 'bin', 'node');
  const moduleDirs = path.join(resources, 'cua_node', 'lib', 'node_modules');
  const codexCli = path.join(resources, 'codex');
  const version = '26.727.51351';
  const pluginRoot = path.join(
    homeDir,
    '.codex',
    'plugins',
    'cache',
    'openai-bundled',
    'chrome',
    version,
  );
  const browserClient = path.join(pluginRoot, 'scripts', 'browser-client.mjs');
  const packageAsset = path.join(pluginRoot, 'skills', 'browser.md');
  const browserClientContent = 'export const browserClient = true;\n';
  const actualHash = createHash('sha256').update(browserClientContent).digest('hex');
  const extensionHost = path.join(
    pluginRoot,
    'extension-host',
    'macos',
    'arm64',
    'ChatGPT for Chrome',
  );
  const signedPluginRoot = path.join(
    resources,
    'plugins',
    'openai-bundled',
    'plugins',
    'chrome',
  );
  const signedBrowserClient = path.join(signedPluginRoot, 'scripts', 'browser-client.mjs');
  const signedPackageAsset = path.join(signedPluginRoot, 'skills', 'browser.md');
  const signedExtensionHost = path.join(
    signedPluginRoot,
    'extension-host',
    'macos',
    'arm64',
    'ChatGPT for Chrome',
  );
  const pluginManifest = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const signedManifest = path.join(signedPluginRoot, '.codex-plugin', 'plugin.json');

  await Promise.all([
    fs.mkdir(path.dirname(nodeRepl), { recursive: true }),
    fs.mkdir(moduleDirs, { recursive: true }),
    fs.mkdir(path.dirname(browserClient), { recursive: true }),
    fs.mkdir(path.dirname(packageAsset), { recursive: true }),
    fs.mkdir(path.dirname(extensionHost), { recursive: true }),
    fs.mkdir(path.dirname(signedBrowserClient), { recursive: true }),
    fs.mkdir(path.dirname(signedPackageAsset), { recursive: true }),
    fs.mkdir(path.dirname(signedExtensionHost), { recursive: true }),
    fs.mkdir(path.dirname(pluginManifest), { recursive: true }),
    fs.mkdir(path.dirname(signedManifest), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(nodeRepl, overrides.nodeReplContent ?? 'node-repl'),
    fs.writeFile(nodePath, 'node'),
    fs.writeFile(codexCli, 'codex'),
    fs.writeFile(browserClient, browserClientContent),
    fs.writeFile(packageAsset, 'signed browser skill'),
    fs.writeFile(signedBrowserClient, browserClientContent),
    fs.writeFile(signedPackageAsset, 'signed browser skill'),
    fs.writeFile(signedExtensionHost, 'extension-host'),
    fs.writeFile(pluginManifest, JSON.stringify({ name: 'chrome', version })),
    fs.writeFile(signedManifest, JSON.stringify({ name: 'chrome', version })),
    ...(overrides.includeExtensionHost === false
      ? []
      : [fs.writeFile(extensionHost, 'extension-host')]),
  ]);
  await Promise.all([
    fs.chmod(nodeRepl, 0o755),
    fs.chmod(nodePath, 0o755),
    fs.chmod(codexCli, 0o755),
    fs.chmod(signedExtensionHost, 0o755),
    ...(overrides.includeExtensionHost === false ? [] : [fs.chmod(extensionHost, 0o755)]),
  ]);

  const sourceConfig = path.join(homeDir, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(sourceConfig), { recursive: true });
  await fs.writeFile(
    sourceConfig,
    [
      '[plugins."chrome@openai-bundled"]',
      `enabled = ${overrides.pluginEnabled === false ? 'false' : 'true'}`,
      '',
      '[mcp_servers.node_repl]',
      ...(overrides.nodeReplEnabled === undefined
        ? []
        : [`enabled = ${overrides.nodeReplEnabled ? 'true' : 'false'}`]),
      `command = ${JSON.stringify(nodeRepl)}`,
      'args = []',
      'startup_timeout_sec = 120',
      '',
      '[mcp_servers.node_repl.env]',
      `NODE_REPL_NODE_MODULE_DIRS = ${JSON.stringify(moduleDirs)}`,
      `NODE_REPL_NODE_PATH = ${JSON.stringify(nodePath)}`,
      `CODEX_CLI_PATH = ${JSON.stringify(codexCli)}`,
      `BROWSER_USE_CODEX_APP_VERSION = ${JSON.stringify(version)}`,
      `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = ${JSON.stringify(actualHash)}`,
      'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
      'NODE_REPL_TRUSTED_CODE_PATHS = "/outside/cindy"',
      overrides.extraEnv ?? '',
      '',
    ].join('\n'),
    'utf8',
  );

  const isolatedMarketplace = path.join(
    codexHome,
    'plugins',
    'cache',
    'openai-bundled',
  );
  await fs.mkdir(path.dirname(isolatedMarketplace), { recursive: true });
  await fs.symlink(
    path.join(homeDir, '.codex', 'plugins', 'cache', 'openai-bundled'),
    isolatedMarketplace,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    [
      '[plugins."chrome@openai-bundled"]',
      `enabled = ${overrides.isolatedPluginEnabled === false ? 'false' : 'true'}`,
      '',
      '[mcp_servers.node_repl.env]',
      'NODE_OPTIONS = "--require=/tmp/untrusted.cjs"',
      `NODE_REPL_TRUSTED_CODE_PATHS = ${JSON.stringify(codexHome)}`,
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.symlink(
    pluginRoot,
    path.join(path.dirname(pluginRoot), 'latest'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  return {
    appBundle,
    browserClient,
    codexHome,
    homeDir,
    nodeRepl,
    pluginRoot,
    signedPluginRoot,
    sourceConfig,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexBrowserCompanion', () => {
  it('anchors macOS verification to the signed OpenAI Codex identity', () => {
    const args = buildOfficialMacBundleVerificationArgs('/tmp/ChatGPT.app');

    expect(args).toEqual([
      '--verify',
      '--deep',
      '--strict',
      '--test-requirement',
      `=${OFFICIAL_MAC_BUNDLE_REQUIREMENT}`,
      '/tmp/ChatGPT.app',
    ]);
    expect(OFFICIAL_MAC_BUNDLE_REQUIREMENT).toContain('anchor apple generic');
    expect(OFFICIAL_MAC_BUNDLE_REQUIREMENT).toContain('identifier "com.openai.codex"');
    expect(OFFICIAL_MAC_BUNDLE_REQUIREMENT).toContain(
      'certificate leaf[subject.OU] = "2DC432GLL2"',
    );
    expect(OFFICIAL_MAC_BUNDLE_REQUIREMENT).toContain(
      'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    );
    expect(OFFICIAL_MAC_BUNDLE_REQUIREMENT).toContain(
      'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    );
  });

  it('parses TeamIdentifier as a complete codesign field', () => {
    expect(hasOfficialMacTeamIdentifier(
      'Executable=/tmp/TeamIdentifier=2DC432GLL2/node_repl\nTeamIdentifier=OTHER',
    )).toBe(false);
    expect(hasOfficialMacTeamIdentifier(
      'Executable=/tmp/node_repl\nTeamIdentifier=2DC432GLL2',
    )).toBe(true);
  });

  it('reports unsupported host platforms without claiming a verified companion', async () => {
    const companion = await prepareCodexBrowserCompanion({
      codexHome: '/tmp/cindy-codex-home',
      platform: 'win32',
      arch: 'x64',
    });

    expect(companion).toMatchObject({
      status: 'unavailable',
      reason: 'platform_unsupported',
    });
    // codex 0.145.0 rejects a config whose node_repl entry has no complete
    // transport ("invalid transport" → child exit 1). With no runnable entry
    // in the isolated config there is nothing to disable, so the fail-closed
    // result must not synthesize one via `-c` overrides.
    expect(resolveCodexBrowserCompanionSpawnConfig(companion)).toEqual({
      codexBrowserUseAvailable: false,
      extraArgs: [],
    });
  });

  it('fails closed against a runnable node_repl entry in the isolated config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-companion-'));
    tempDirs.push(root);
    const codexHome = path.join(root, 'cindy-codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[mcp_servers.node_repl]',
        'command = "/tmp/untrusted/node_repl"',
        '',
      ].join('\n'),
      'utf8',
    );

    const companion = await prepareCodexBrowserCompanion({
      codexHome,
      platform: 'win32',
      arch: 'x64',
    });

    expect(companion).toMatchObject({
      status: 'unavailable',
      reason: 'platform_unsupported',
    });
    expect(resolveCodexBrowserCompanionSpawnConfig(companion)).toEqual({
      codexBrowserUseAvailable: false,
      extraArgs: ['-c', 'mcp_servers.node_repl.enabled=false'],
    });
  });

  it('does not complete a transport-less node_repl entry into a fatal override', async () => {
    // A `-c mcp_servers.node_repl.*` override on a transport-less entry turns
    // codex's survivable "Invalid configuration; using defaults" degradation
    // into a fatal config load error. Codex already refuses to run such an
    // entry, so no override may be emitted.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-companion-'));
    tempDirs.push(root);
    const codexHome = path.join(root, 'cindy-codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[mcp_servers.node_repl.env]',
        'NODE_OPTIONS = "--require=/tmp/untrusted.cjs"',
        '',
      ].join('\n'),
      'utf8',
    );

    const companion = await prepareCodexBrowserCompanion({
      codexHome,
      platform: 'win32',
      arch: 'x64',
    });

    expect(companion).toMatchObject({
      status: 'unavailable',
      reason: 'platform_unsupported',
    });
    expect(resolveCodexBrowserCompanionSpawnConfig(companion)).toEqual({
      codexBrowserUseAvailable: false,
      extraArgs: [],
    });
  });

  it('keeps the control-plane host neutral when no companion preflight applies', () => {
    expect(resolveCodexBrowserCompanionSpawnConfig(null)).toEqual({
      codexBrowserUseAvailable: false,
      extraArgs: [],
    });
  });

  it('injects an allowlisted Chrome-only companion config for the isolated Codex home', async () => {
    const { appBundle, codexHome, homeDir, nodeRepl, signedPluginRoot } = await setup({
      extraEnv: 'MALICIOUS_SECRET = "must-not-cross"',
    });

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async (candidate) => candidate === appBundle,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.extraArgs).toContain('mcp_servers.node_repl.enabled=true');
    expect(result.extraArgs).toContain('mcp_servers.node_repl.command="/usr/bin/env"');
    const argsOverride = result.extraArgs.find((arg) => (
      arg.startsWith('mcp_servers.node_repl.args=')
    ));
    expect(argsOverride).toBeDefined();
    const cleanArgs = JSON.parse(
      argsOverride!.slice('mcp_servers.node_repl.args='.length),
    ) as string[];
    expect(cleanArgs[0]).toBe('-i');
    expect(cleanArgs.at(-1)).toBe(nodeRepl);
    expect(cleanArgs).toContain(`CODEX_HOME=${codexHome}`);
    expect(cleanArgs).toContain('BROWSER_USE_AVAILABLE_BACKENDS=chrome');
    expect(cleanArgs.some((arg) => arg.startsWith('NODE_REPL_TRUSTED_CODE_PATHS=')))
      .toBe(false);
    expect(cleanArgs.some((arg) => arg.startsWith('NODE_OPTIONS='))).toBe(false);
    expect(cleanArgs.some((arg) => arg.startsWith('MALICIOUS_SECRET='))).toBe(false);
    expect(result.startupTimeoutMs).toBe(120_000);
    expect(result.browserClientPath).toBe(
      path.join(signedPluginRoot, 'scripts', 'browser-client.mjs'),
    );
    expect(resolveCodexBrowserCompanionSpawnConfig(result)).toEqual({
      codexBrowserUseAvailable: true,
      extraArgs: result.extraArgs,
    });
  });

  it('rejects a latest selector that points at a different plugin version', async () => {
    const { codexHome, homeDir, pluginRoot } = await setup();
    const latest = path.join(path.dirname(pluginRoot), 'latest');
    const otherVersion = path.join(path.dirname(pluginRoot), 'other-version');
    await fs.unlink(latest);
    await fs.mkdir(otherVersion);
    await fs.symlink(
      otherVersion,
      latest,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'runtime_missing' });
  });

  it('rejects a Chrome plugin disabled in the isolated runtime even when the source is enabled', async () => {
    const { codexHome, homeDir } = await setup({ isolatedPluginEnabled: false });

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_not_installed' });
  });

  it('does not re-enable a node_repl descriptor disabled by the user', async () => {
    const { codexHome, homeDir } = await setup({ nodeReplEnabled: false });

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'provider_not_installed',
    });
  });

  it('revalidates the signed app bundle for each host provision', async () => {
    const { appBundle, codexHome, homeDir } = await setup();
    const verifyMacBundle = vi.fn(async (candidate: string) => candidate === appBundle);

    await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle,
    });
    await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle,
    });

    expect(verifyMacBundle).toHaveBeenCalledTimes(2);
  });

  it('rejects a node_repl command outside an official macOS app bundle layout', async () => {
    const { codexHome, homeDir, sourceConfig } = await setup();
    const sourceText = await fs.readFile(sourceConfig, 'utf8');
    await fs.writeFile(
      sourceConfig,
      sourceText.replace(
        /^command = .*$/m,
        `command = ${JSON.stringify(path.join(homeDir, 'untrusted', 'node_repl'))}`,
      ),
      'utf8',
    );

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_untrusted' });
  });

  it('rejects a browser client whose exact plugin-version hash is not trusted', async () => {
    const { browserClient, codexHome, homeDir } = await setup();
    await fs.writeFile(browserClient, 'tampered browser client');

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'browser_client_untrusted',
    });
  });

  it('does not expose a half-installed companion without its extension host', async () => {
    const { codexHome, homeDir } = await setup({ includeExtensionHost: false });

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'extension_host_missing',
    });
  });

  it('rejects a tampered signed package asset beyond browser-client.mjs', async () => {
    const { codexHome, homeDir, pluginRoot } = await setup();
    await fs.writeFile(path.join(pluginRoot, 'skills', 'browser.md'), 'tampered browser skill');

    const result = await prepareCodexBrowserCompanion({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'plugin_package_untrusted',
    });
  });

  it('fails closed when the verified runtime has no connected Chrome browser', async () => {
    const { codexHome, homeDir } = await setup();

    const result = await checkCodexBrowserCompanionConnection(
      {
        codexHome,
        homeDir,
        platform: 'darwin',
        arch: 'arm64',
        verifyMacBundle: async () => true,
      },
      async () => false,
    );

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'browser_unavailable',
    });
  });

  it.skipIf(process.platform === 'win32')('probes Chrome through the clean node_repl transport at session time', async () => {
    const fakeNodeRepl = [
      `#!${process.execPath}`,
      "const readline = require('node:readline');",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id == null) return;",
      "  let result = {};",
      "  if (request.method === 'initialize') {",
      "    result = {",
      "      protocolVersion: request.params.protocolVersion,",
      "      capabilities: { tools: {} },",
      "      serverInfo: { name: 'fake-node-repl', version: '0.0.0' },",
      "    };",
      "  } else if (request.method === 'tools/call') {",
      "    const metadata = request.params._meta?.['x-codex-turn-metadata'];",
      "    const code = request.params.arguments?.code ?? '';",
      "    const valid = request.params.name === 'js'",
      "      && typeof metadata?.session_id === 'string'",
      "      && typeof metadata?.turn_id === 'string'",
      "      && code.includes('setupBrowserRuntime')",
      "      && code.includes('agent.browsers.list()')",
      "      && code.includes('setTimeout(resolve, 2000)');",
      "    result = { content: [{ type: 'text', text: String(valid) }], isError: false };",
      "  }",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
      "});",
      '',
    ].join('\n');
    const { codexHome, homeDir, nodeRepl, signedPluginRoot } = await setup({
      nodeReplContent: fakeNodeRepl,
    });
    const signedBrowserClient = path.join(signedPluginRoot, 'scripts', 'browser-client.mjs');
    await fs.writeFile(
      nodeRepl,
      fakeNodeRepl.replace(
        "      && code.includes('agent.browsers.list()')",
        `      && code.includes(${JSON.stringify(signedBrowserClient)})\n      && code.includes('agent.browsers.list()')`,
      ),
      'utf8',
    );

    const result = await checkCodexBrowserCompanionConnection({
      codexHome,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      verifyMacBundle: async () => true,
    });

    expect(result).toMatchObject({ status: 'ready', version: '26.727.51351' });
  });
});
