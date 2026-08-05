import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const OPENAI_TEAM_ID = '2DC432GLL2';
const SOURCE_PLUGIN_KEY = 'chrome@openai-bundled';

/**
 * Match the signed Codex app's designated requirement, not merely a valid
 * self-signed bundle that happens to report OpenAI's TeamIdentifier.
 */
export const OFFICIAL_MAC_BUNDLE_REQUIREMENT = [
  'anchor apple generic',
  'identifier "com.openai.codex"',
  'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
  'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
  `certificate leaf[subject.OU] = "${OPENAI_TEAM_ID}"`,
].join(' and ');

export type CodexBrowserCompanionUnavailableReason =
  | 'provider_not_installed'
  | 'platform_unsupported'
  | 'descriptor_invalid'
  | 'provider_untrusted'
  | 'runtime_missing'
  | 'browser_client_untrusted'
  | 'plugin_package_untrusted'
  | 'extension_host_missing'
  | 'browser_unavailable';

export type CodexBrowserCompanionResult =
  | {
      status: 'ready';
      extraArgs: string[];
      version: string;
      startupTimeoutMs: number;
      browserClientPath: string;
    }
  | {
      status: 'unavailable';
      /** Fail-closed spawn overrides prepared for this result (may be empty). */
      extraArgs: string[];
      reason: CodexBrowserCompanionUnavailableReason;
      detail: string;
    };

export type CodexBrowserCompanionSpawnConfig = {
  codexBrowserUseAvailable: boolean;
  extraArgs: string[];
};

/**
 * Only a verified companion may enable Cindy's privileged node_repl bridge.
 * A null result belongs to the control-plane host and must remain neutral;
 * every concrete unavailable result fails closed for the local app-server
 * (its extraArgs carry the disable override when one is applicable).
 */
export function resolveCodexBrowserCompanionSpawnConfig(
  companion: CodexBrowserCompanionResult | null,
): CodexBrowserCompanionSpawnConfig {
  if (companion === null) {
    return { codexBrowserUseAvailable: false, extraArgs: [] };
  }
  return {
    codexBrowserUseAvailable: companion.status === 'ready',
    extraArgs: companion.extraArgs,
  };
}

interface PrepareCodexBrowserCompanionOptions {
  codexHome: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests can replace macOS signature verification without spawning codesign. */
  verifyMacBundle?: (appBundle: string) => Promise<boolean>;
}

function unavailable(
  reason: CodexBrowserCompanionUnavailableReason,
  detail: string,
): CodexBrowserCompanionResult {
  return { status: 'unavailable', extraArgs: [], reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(file: string, mode = fsConstants.F_OK): Promise<boolean> {
  try {
    await fsp.access(file, mode);
    return true;
  } catch {
    return false;
  }
}

async function runOfficialMacBundleVerification(appBundle: string): Promise<boolean> {
  try {
    await execFileAsync(
      '/usr/bin/codesign',
      buildOfficialMacBundleVerificationArgs(appBundle),
    );
    const { stderr } = await execFileAsync('/usr/bin/codesign', [
      '-dv',
      '--verbose=4',
      appBundle,
    ]);
    return hasOfficialMacTeamIdentifier(stderr);
  } catch {
    return false;
  }
}

/** Keep the privileged verifier's trust requirement visible and testable. */
export function buildOfficialMacBundleVerificationArgs(appBundle: string): string[] {
  return [
    '--verify',
    '--deep',
    '--strict',
    '--test-requirement',
    `=${OFFICIAL_MAC_BUNDLE_REQUIREMENT}`,
    appBundle,
  ];
}

/** Parse the codesign descriptor as fields, never as an arbitrary substring. */
export function hasOfficialMacTeamIdentifier(descriptor: string): boolean {
  return descriptor.split(/\r?\n/).some((line) => {
    const match = /^TeamIdentifier=([A-Za-z0-9]+)$/.exec(line.trim());
    return match?.[1] === OPENAI_TEAM_ID;
  });
}

function verifyOfficialMacBundle(appBundle: string): Promise<boolean> {
  // Do not cache by pathname: ChatGPT.app can be replaced in place by an
  // updater, and a stale positive verification would stop being a trust root.
  return runOfficialMacBundleVerification(appBundle);
}

function macBundleForNodeRepl(command: string): string | null {
  const suffix = path.join('Contents', 'Resources', 'cua_node', 'bin', 'node_repl');
  if (!path.isAbsolute(command) || !command.endsWith(suffix)) return null;
  const appBundle = command.slice(0, -suffix.length).replace(/[\\/]$/, '');
  return appBundle.endsWith('.app') ? appBundle : null;
}

function extensionHostPath(
  pluginRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  if (arch !== 'arm64' && arch !== 'x64') return null;
  if (platform === 'darwin') {
    return path.join(pluginRoot, 'extension-host', 'macos', arch, 'ChatGPT for Chrome');
  }
  return null;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

async function collectPackageTree(
  root: string,
  relativeRoot = '',
): Promise<Map<string, string>> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const tree = new Map<string, string>();
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    const relativePath = relativeRoot
      ? `${relativeRoot}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      tree.set(`${relativePath}/`, 'directory');
      for (const [childPath, childHash] of await collectPackageTree(absolutePath, relativePath)) {
        tree.set(childPath, childHash);
      }
      continue;
    }
    if (entry.isFile()) {
      tree.set(relativePath, `file:${await sha256(absolutePath)}`);
      continue;
    }
    throw new Error(`unsupported package entry: ${relativePath}`);
  }
  return tree;
}

async function packageTreesMatch(activeRoot: string, signedRoot: string): Promise<boolean> {
  try {
    const [activeTree, signedTree] = await Promise.all([
      collectPackageTree(activeRoot),
      collectPackageTree(signedRoot),
    ]);
    if (activeTree.size !== signedTree.size) return false;
    for (const [relativePath, signedHash] of signedTree) {
      if (activeTree.get(relativePath) !== signedHash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    void task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function probeCodexChrome(
  companion: Extract<CodexBrowserCompanionResult, { status: 'ready' }>,
): Promise<boolean> {
  const encodedArgs = companion.extraArgs.find((arg) => (
    arg.startsWith('mcp_servers.node_repl.args=')
  ));
  if (!encodedArgs) return false;
  const parsedArgs: unknown = JSON.parse(
    encodedArgs.slice('mcp_servers.node_repl.args='.length),
  );
  if (
    !Array.isArray(parsedArgs)
    || parsedArgs.some((arg) => typeof arg !== 'string')
  ) return false;
  const args = parsedArgs as string[];

  const transport = new StdioClientTransport({
    command: '/usr/bin/env',
    args,
    stderr: 'pipe',
  });
  // The child emits diagnostics on stderr. Drain the pipe so a noisy failure
  // cannot block shutdown; the caller reports only the stable availability fact.
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'cindy-browser-preflight', version: '0.0.0' });
  const probeTimeoutMs = Math.min(companion.startupTimeoutMs, 10_000);
  try {
    return await withTimeout((async () => {
      await client.connect(transport);
      // The wrapper passes the isolated CODEX_HOME to node_repl, but this host
      // process may use a different CODEX_HOME. Recover the verified path from
      // the clean child environment instead of relying on process.env.
      const codexHomeArg = args.find((arg) => arg.startsWith('CODEX_HOME='));
      if (!codexHomeArg) return false;
      const verifiedBrowserClient = companion.browserClientPath;
      const turnMetadata = {
        'x-codex-turn-metadata': {
          session_id: `cindy-browser-preflight-${randomUUID()}`,
          turn_id: randomUUID(),
        },
      };
      const result = await client.callTool({
        name: 'js',
        arguments: {
          code: [
            'if (globalThis.agent?.browsers == null) {',
            `  const { setupBrowserRuntime } = await import(${JSON.stringify(verifiedBrowserClient)});`,
            '  await setupBrowserRuntime({ globals: globalThis });',
            '}',
            'var cindyChromeCandidates = await agent.browsers.list();',
            'if (!cindyChromeCandidates.some((browser) => browser.type === "extension" && browser.family === "chrome")) {',
            '  await new Promise((resolve) => setTimeout(resolve, 2000));',
            '  cindyChromeCandidates = await agent.browsers.list();',
            '}',
            'nodeRepl.write(cindyChromeCandidates.some((browser) => browser.type === "extension" && browser.family === "chrome"));',
          ].join('\n'),
          timeout_ms: probeTimeoutMs,
        },
        _meta: turnMetadata,
      });
      if (
        result.isError === true
        || !('content' in result)
        || !Array.isArray(result.content)
      ) return false;
      return result.content.some((item: unknown) => (
        isRecord(item)
        && item.type === 'text'
        && typeof item.text === 'string'
        && item.text.trim() === 'true'
      ));
    })(), probeTimeoutMs, 'Chrome browser connection probe');
  } catch {
    return false;
  } finally {
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup after a failed or timed-out preflight.
      }
    }
  }
}

/**
 * Build an ephemeral, allowlisted node_repl configuration for this app-server.
 * The user's Codex config is only a descriptor source; its arbitrary commands
 * and environment variables are never copied into Cindy's isolated runtime.
 */
async function inspectCodexBrowserCompanion(
  opts: PrepareCodexBrowserCompanionOptions,
): Promise<CodexBrowserCompanionResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const homeDir = opts.homeDir ?? os.homedir();
  if (platform !== 'darwin') {
    return unavailable(
      'platform_unsupported',
      `official Codex Browser companion validation is not implemented for ${platform}`,
    );
  }

  const sourceHome = path.join(homeDir, '.codex');
  const sourceConfig = path.join(sourceHome, 'config.toml');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(await fsp.readFile(sourceConfig, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return unavailable(
      'provider_not_installed',
      `cannot read the official Codex companion descriptor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const sourcePlugin = plugins[SOURCE_PLUGIN_KEY];
  if (!isRecord(sourcePlugin) || sourcePlugin.enabled !== true) {
    return unavailable('provider_not_installed', `${SOURCE_PLUGIN_KEY} is not enabled`);
  }
  const mcpServers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const nodeRepl = mcpServers.node_repl;
  if (!isRecord(nodeRepl)) {
    return unavailable('descriptor_invalid', 'the official node_repl descriptor is missing');
  }
  if (nodeRepl.enabled === false) {
    return unavailable('provider_not_installed', 'node_repl is disabled in the official Codex config');
  }
  if (typeof nodeRepl.command !== 'string') {
    return unavailable('descriptor_invalid', 'the official node_repl descriptor is missing');
  }
  if (
    nodeRepl.args !== undefined
    && (!Array.isArray(nodeRepl.args) || nodeRepl.args.length !== 0)
  ) {
    return unavailable('descriptor_invalid', 'node_repl arguments are not allowlisted');
  }
  const env = isRecord(nodeRepl.env) ? nodeRepl.env : null;
  const appBundle = macBundleForNodeRepl(nodeRepl.command);
  const verifyMacBundle = opts.verifyMacBundle ?? verifyOfficialMacBundle;
  if (!appBundle || !(await verifyMacBundle(appBundle))) {
    return unavailable('provider_untrusted', 'node_repl is not inside an OpenAI-signed app bundle');
  }

  const nodePath = env?.NODE_REPL_NODE_PATH;
  const moduleDirs = env?.NODE_REPL_NODE_MODULE_DIRS;
  const codexCliPath = env?.CODEX_CLI_PATH;
  const requiredExecutables = [nodeRepl.command, nodePath, codexCliPath];
  if (
    requiredExecutables.some((value) => typeof value !== 'string')
    || typeof moduleDirs !== 'string'
  ) {
    return unavailable('descriptor_invalid', 'required companion runtime paths are missing');
  }
  const resources = path.join(appBundle, 'Contents', 'Resources');
  const expectedRuntimePaths = {
    nodeRepl: path.join(resources, 'cua_node', 'bin', 'node_repl'),
    nodePath: path.join(resources, 'cua_node', 'bin', 'node'),
    moduleDirs: path.join(resources, 'cua_node', 'lib', 'node_modules'),
    codexCliPath: path.join(resources, 'codex'),
  };
  const requiredPaths = [
    // Tests may simulate a macOS target on a Windows runner. The production
    // macOS path is still checked against the real system executable.
    ...(platform === process.platform ? [['/usr/bin/env', fsConstants.X_OK] as const] : []),
    [nodeRepl.command, fsConstants.X_OK],
    [nodePath as string, fsConstants.X_OK],
    [codexCliPath as string, fsConstants.X_OK],
    [moduleDirs, fsConstants.F_OK],
  ] as const;
  for (const [file, mode] of requiredPaths) {
    if (!(await exists(file, mode))) {
      return unavailable('runtime_missing', `required companion runtime is missing: ${file}`);
    }
  }
  const [actualNodeRepl, actualNodePath, actualModuleDirs, actualCodexCli, expectedNodeRepl,
    expectedNodePath, expectedModuleDirs, expectedCodexCli] = await Promise.all([
    fsp.realpath(nodeRepl.command),
    fsp.realpath(nodePath as string),
    fsp.realpath(moduleDirs),
    fsp.realpath(codexCliPath as string),
    fsp.realpath(expectedRuntimePaths.nodeRepl),
    fsp.realpath(expectedRuntimePaths.nodePath),
    fsp.realpath(expectedRuntimePaths.moduleDirs),
    fsp.realpath(expectedRuntimePaths.codexCliPath),
  ]);
  if (
    actualNodeRepl !== expectedNodeRepl
    || actualNodePath !== expectedNodePath
    || actualModuleDirs !== expectedModuleDirs
    || actualCodexCli !== expectedCodexCli
  ) {
    return unavailable(
      'provider_untrusted',
      'the companion descriptor points outside its signed app bundle runtime',
    );
  }
  const signedPluginRoot = path.join(
    resources,
    'plugins',
    'openai-bundled',
    'plugins',
    'chrome',
  );
  let version: string;
  try {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(signedPluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (manifest.name !== 'chrome' || typeof manifest.version !== 'string') {
      throw new Error('invalid signed Chrome plugin manifest');
    }
    version = manifest.version;
  } catch (error) {
    return unavailable(
      'runtime_missing',
      `signed Chrome plugin metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let isolatedConfig: Record<string, unknown>;
  try {
    isolatedConfig = parseToml(
      await fsp.readFile(path.join(opts.codexHome, 'config.toml'), 'utf8'),
    ) as Record<string, unknown>;
  } catch (error) {
    return unavailable(
      'provider_not_installed',
      `cannot read Cindy's isolated Codex plugin config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const isolatedPlugins = isRecord(isolatedConfig.plugins) ? isolatedConfig.plugins : {};
  const isolatedPlugin = isolatedPlugins[SOURCE_PLUGIN_KEY];
  if (!isRecord(isolatedPlugin) || isolatedPlugin.enabled !== true) {
    return unavailable(
      'provider_not_installed',
      `${SOURCE_PLUGIN_KEY} is not enabled in Cindy's isolated Codex runtime`,
    );
  }

  const pluginRoot = path.join(
    opts.codexHome,
    'plugins',
    'cache',
    'openai-bundled',
    'chrome',
    version,
  );
  const selectedPluginRoot = path.join(path.dirname(pluginRoot), 'latest');
  try {
    const [selectedRoot, exactRoot] = await Promise.all([
      fsp.realpath(selectedPluginRoot),
      fsp.realpath(pluginRoot),
    ]);
    if (selectedRoot !== exactRoot) {
      return unavailable(
        'runtime_missing',
        `the active Chrome plugin does not match the signed version ${version}`,
      );
    }
  } catch (error) {
    return unavailable(
      'runtime_missing',
      `cannot resolve the active Chrome plugin version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const browserClient = path.join(pluginRoot, 'scripts', 'browser-client.mjs');
  if (!(await exists(browserClient))) {
    return unavailable('runtime_missing', `browser client is missing for plugin version ${version}`);
  }
  const actualHash = await sha256(browserClient);
  const signedBrowserClient = path.join(signedPluginRoot, 'scripts', 'browser-client.mjs');
  if (!(await exists(signedBrowserClient)) || actualHash !== await sha256(signedBrowserClient)) {
    return unavailable(
      'browser_client_untrusted',
      `browser client does not match the signed plugin version ${version}`,
    );
  }
  const hostPath = extensionHostPath(pluginRoot, platform, arch);
  const signedHostPath = extensionHostPath(signedPluginRoot, platform, arch);
  if (
    !hostPath
    || !signedHostPath
    || !(await exists(hostPath, fsConstants.X_OK))
    || !(await exists(signedHostPath, fsConstants.X_OK))
    || await sha256(hostPath) !== await sha256(signedHostPath)
  ) {
    return unavailable(
      'extension_host_missing',
      `Chrome extension host is missing for ${platform}/${arch}`,
    );
  }
  if (!(await packageTreesMatch(pluginRoot, signedPluginRoot))) {
    return unavailable(
      'plugin_package_untrusted',
      `the active Chrome plugin package does not match the signed version ${version}`,
    );
  }

  const startupTimeout =
    typeof nodeRepl.startup_timeout_sec === 'number'
    && Number.isFinite(nodeRepl.startup_timeout_sec)
    && nodeRepl.startup_timeout_sec > 0
      ? Math.min(nodeRepl.startup_timeout_sec, 300)
      : 120;
  const injectedEnv: Record<string, string> = {
    CODEX_HOME: opts.codexHome,
    CODEX_CLI_PATH: codexCliPath as string,
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    NODE_REPL_NODE_MODULE_DIRS: moduleDirs,
    NODE_REPL_NODE_PATH: nodePath as string,
    // The exact signed browser-client hash is enough to enter the privileged
    // context; its dependency graph inherits that context. Trusting the whole
    // CODEX_HOME would also trust arbitrary third-party plugin code.
    NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: actualHash,
    NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
      'Control Chrome through the official Codex Browser plugin.',
    NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME:
      'Control Chrome through the official Codex Chrome plugin.',
    // Cindy has no ChatGPT in-app-browser host. Exposing it makes getDefault()
    // select an endpoint that can never connect; Chrome is the supported fallback.
    BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
    BROWSER_USE_CODEX_APP_VERSION: version,
  };
  const cleanEnvironment = {
    HOME: homeDir,
    PATH: '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
    ...injectedEnv,
  };
  const cleanEnvironmentArgs = [
    '-i',
    ...Object.entries(cleanEnvironment).map(([key, value]) => `${key}=${value}`),
    nodeRepl.command,
  ];

  const extraArgs = [
    '-c',
    'mcp_servers.node_repl.command="/usr/bin/env"',
    '-c',
    // `-c` maps deep-merge with an existing config, so replacing `.env` alone
    // cannot delete stale keys. Launch through `env -i` instead: the signed
    // node_repl receives only this allowlist even if the config contains
    // NODE_OPTIONS, broad trusted paths, service paths, or arbitrary secrets.
    `mcp_servers.node_repl.args=${JSON.stringify(cleanEnvironmentArgs)}`,
    '-c',
    `mcp_servers.node_repl.startup_timeout_sec=${startupTimeout}`,
    '-c',
    'mcp_servers.node_repl.enabled=true',
  ];
  return {
    status: 'ready',
    extraArgs,
    version,
    startupTimeoutMs: startupTimeout * 1_000,
    browserClientPath: signedBrowserClient,
  };
}

/**
 * Codex 0.145.0's config loader requires every `mcp_servers` entry to carry a
 * complete transport even when disabled: a bare
 * `-c mcp_servers.node_repl.enabled=false` on a config whose node_repl entry
 * is missing (or transport-less) synthesizes/completes an invalid entry and
 * kills the app-server at spawn ("invalid transport", child exit 1; verified
 * against codex-cli 0.145.0). Only emit the fail-closed disable when the
 * isolated config defines the entry with a real transport — the override then
 * deep-merges onto that transport, which the loader accepts. In every other
 * case codex itself refuses to load a runnable node_repl from that config
 * (absent entry, or "Invalid configuration; using defaults"), so fail-closed
 * already holds without an override.
 */
async function nodeReplFailClosedOverrideArgs(codexHome: string): Promise<string[]> {
  try {
    const parsed = parseToml(
      await fsp.readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    ) as Record<string, unknown>;
    const mcpServers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
    const nodeRepl = mcpServers.node_repl;
    if (
      isRecord(nodeRepl)
      && (typeof nodeRepl.command === 'string' || typeof nodeRepl.url === 'string')
    ) {
      return ['-c', 'mcp_servers.node_repl.enabled=false'];
    }
  } catch {
    // Missing or unparseable isolated config: codex cannot load a node_repl
    // entry from it either, so there is nothing to fail closed against.
  }
  return [];
}

export async function prepareCodexBrowserCompanion(
  opts: PrepareCodexBrowserCompanionOptions,
): Promise<CodexBrowserCompanionResult> {
  let result: CodexBrowserCompanionResult;
  try {
    result = await inspectCodexBrowserCompanion(opts);
  } catch (error) {
    result = unavailable(
      'descriptor_invalid',
      `browser companion preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === 'unavailable') {
    return { ...result, extraArgs: await nodeReplFailClosedOverrideArgs(opts.codexHome) };
  }
  return result;
}

/**
 * Session-time health gate for the dynamic Chrome connection. Unlike static
 * provisioning, this result must not be frozen into the shared app-server:
 * Chrome can connect or disconnect while Cindy remains open.
 */
export async function checkCodexBrowserCompanionConnection(
  opts: PrepareCodexBrowserCompanionOptions,
  probeChrome: typeof probeCodexChrome = probeCodexChrome,
): Promise<CodexBrowserCompanionResult> {
  const companion = await prepareCodexBrowserCompanion(opts);
  if (companion.status !== 'ready') return companion;
  if (await probeChrome(companion)) return companion;
  return unavailable(
    'browser_unavailable',
    'the verified Chrome extension runtime did not publish a connected Chrome browser',
  );
}
