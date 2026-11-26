/**
 * Generic Agent Client Protocol (ACP v1) engine.
 *
 * See docs/plans/acp-plugin-bridge.md. Hosts register AcpAgent under the
 * 'acp' engine kind only while at least one plugin provides an ACP harness;
 * the built-in engines never import this module.
 */

export {
  ACP_PROTOCOL_VERSION,
  type AcpAuthMethod,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpMcpServer,
} from './protocol.js';
export {
  ACP_DEFAULT_MAX_LINE_CHARS,
  AcpLineDecoder,
  AcpLineTooLongError,
  type AcpLineTransport,
  type AcpTransportClosed,
} from './line-transport.js';
export { AcpConnectionClosedError, AcpRequestTimeoutError, AcpRpcError } from './connection.js';
export { ACP_PERMISSION_MODES, buildAcpCapabilities, describeAcpModels } from './capabilities.js';
export {
  AcpAccountError,
  AcpAuthRequiredError,
  AcpProtocolVersionError,
  AcpRequiredMcpUnavailableError,
  AcpResumeUnavailableError,
  AcpSession,
  openAcpSession,
  type AcpClientInfo,
  type AcpResumeOutcome,
  type OpenAcpSessionOptions,
} from './session.js';
export {
  ACP_PLUGIN_PROVIDER_PREFIX,
  AcpAgent,
  acpHarnessKeyFromProviderId,
  acpMcpServersFromBridge,
  acpProviderIdForHarness,
  type AcpAgentDeps,
  type AcpEndpointConnectOptions,
  type AcpEndpointLauncher,
} from './acp-agent.js';
export {
  CINDY_PLUGIN_GATEWAY_MCP_SERVER,
  collectPluginEngineSkillNames,
  defusePluginEngineHandoffPrefix,
  defusePluginEngineSlashMentions,
  defusePluginEngineWireEnvelope,
  formatPluginEngineSkillList,
  isLeadingSlashCommand,
  renderPluginEngineCapabilityBriefing,
  type PluginEngineBriefingSkill,
  type PluginEngineWireMessage,
} from './briefing.js';
