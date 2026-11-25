/**
 * AgentDeps is one interface for the three engines. These bags write out, once, the optional ports
 * that only another engine reads, so each Host engine bag in runtime.ts can be built with
 * `explicitPorts` (explicit-ports.ts) without repeating them: a port the desktop adds later fails every
 * engine bag until it is placed here or bound.
 *
 * Classified by reading maker-core (2026-11-17): a port belongs to the engines whose agent code
 * (`agents/claude-code`, `agents/codex`, `agents/pi`) reads it from its deps; a port read in shared agent
 * code (`base-agent.ts`) counts as read by all three and is not in any bag here. `toolLoopReviewer` is
 * read by the Claude agent only (Codex and Pi take Maker's, MakerDeps.toolLoopReviewer). The agents keep
 * the deps object as given and read its members with `?.` or `??`, so an explicit `undefined` is the same
 * as an absent key.
 */
import type { AgentDeps } from '@cindy/maker-core';

type UnreadPorts = { [K in keyof AgentDeps]?: undefined };

/** Ports only the Codex agent reads. */
export const PORTS_ONLY_CODEX_READS = {
  armCodexHttpRecovery: undefined,
  getRejectedCodexDownshiftModel: undefined,
  createCodexAuthTokenReader: undefined,
  disableCodexPluginRuntime: undefined,
  getCodexServerCompactionPreference: undefined,
  getCodexSubagentIdentity: undefined,
  getOutboundPathFact: undefined,
  getRemoteCodexTransport: undefined,
  isCodexAccountProvider: undefined,
  isolateCodexAccountSessions: undefined,
  needsCodexFastCatalog: undefined,
  onCodexLocalModelsListed: undefined,
  prepareCodexExtraSpawnConfig: undefined,
  prepareCodexHostToolCatalog: undefined,
  prepareCodexLocalCredentialModeSwitch: undefined,
  prepareCodexMcpToolCancellation: undefined,
  prepareCodexResumeSession: undefined,
  prepareCodexSkills: undefined,
  recordCodexThreadLocation: undefined,
  registerCodexChildThreadForParent: undefined,
  registerCodexMcpThreadContext: undefined,
  registerCodexSystemPromptForThread: undefined,
  registerCodexTextOnlyPolicy: undefined,
  registerLocalCodexAppServerProcess: undefined,
  resolveCapabilityRouting: undefined,
  resolveCodexContextWindowInfo: undefined,
  resolveCodexLocalAuthPolicy: undefined,
  resolveCodexSubagentRoutingSignature: undefined,
  resolveCodexThreadContextWindow: undefined,
  resolveCodexThreadStorage: undefined,
  unregisterCodexMcpThreadContext: undefined,
  withCodexMcpDiscoveryContext: undefined,
} as const satisfies UnreadPorts;

/** Ports only the Pi agent reads. */
export const PORTS_ONLY_PI_READS = {
  derivePiProxySessionToken: undefined,
  formatPiStartupCloudFileHint: undefined,
  getLocalPiHttpsProxy: undefined,
  getPiExtensionUiStrings: undefined,
  getRemotePiAgentProxyEnv: undefined,
  getRemotePiFileOps: undefined,
  getRemotePiTransport: undefined,
  // #12298: the Pi agent reads the host's subscription connection state; Claude and Codex route
  // subagent models from their own catalogs and never consult it.
  isNativeProviderSourceConnected: undefined,
  mutatePiManagedPackage: undefined,
  onPiManagedPackageMutationSettled: undefined,
  preparePiExtraSpawnConfig: undefined,
  probeRemotePiProviderEndpoint: undefined,
  registerPiProxySession: undefined,
  remotePiSkipMcpBridge: undefined,
  resolvePiAgentHome: undefined,
  resolvePiGatewayModelApi: undefined,
  resolvePiGatewayModelDescriptor: undefined,
  resolvePiGatewayModelSpec: undefined,
  resolvePiGlobalContextHome: undefined,
  resolvePiManagedPackageResources: undefined,
  resolvePiNativeCompatOverride: undefined,
  resolvePiNativeCompatStorePath: undefined,
  resolvePiNativePackagePaths: undefined,
  resolvePiNativeProviders: undefined,
  resolvePiProjectTrustInput: undefined,
  resolvePiRuntimeModelDescriptor: undefined,
  resolvePiRuntimeModels: undefined,
  resolveRemotePiBinaryPath: undefined,
  spawnPiSubagentRunner: undefined,
} as const satisfies UnreadPorts;

/** Ports only the Claude agent reads. */
export const PORTS_ONLY_CLAUDE_READS = {
  claudeAllowedTools: undefined,
  claudeHooks: undefined,
  getClaudeSubagentTaskUsage: undefined,
  registerClaudeSubagentTask: undefined,
  remoteCcQueryFactory: undefined,
  resolveCcDebugFile: undefined,
  resolveClaudeSubagentModelAccess: undefined,
  resolveLocalMcpDuplicateChoices: undefined,
  resolveModelEfforts: undefined,
  resolveModelMaxOutputTokens: undefined,
  resolveRemoteClaudeRoute: undefined,
  toolLoopReviewer: undefined,
  trackCcDebugFile: undefined,
} as const satisfies UnreadPorts;

/** Ports only the Claude and Pi agents read. */
export const PORTS_ONLY_CLAUDE_AND_PI_READ = {
  registerLocalAgentProcess: undefined,
  toolLifecycleControl: undefined,
  turnChangeCapture: undefined,
} as const satisfies UnreadPorts;

/** Ports only the Claude and Codex agents read. */
export const PORTS_ONLY_CLAUDE_AND_CODEX_READ = {
  capabilityRouting: undefined,
  resolveVerifiedContextWindow: undefined,
} as const satisfies UnreadPorts;
