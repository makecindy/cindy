/** Test-only facade: re-export the real device-link submodules used by the continuity graph.
 * Importing the package root here would load client/relay/direct/transfer assembly that this
 * unit test never executes. Keep every value sourced from the real SDK modules. */
export {
  PROTOCOL_VERSION,
  isScopedPeer,
  parseProviderSharePeer,
  providerShareGuestPeer,
  providerShareHostPeer,
  isProviderSharePeer,
} from '../../../../../../packages/device-link/src/protocol';
export { encodeReliableFrames, parseTransportPayload } from '../../../../../../packages/device-link/src/transport';
export {
  PROVIDER_GROUP_REMOTE_CHANNEL,
  PROVIDER_RUNNING_TURNS_FIELD,
} from '../../../../../../packages/device-link/src/providerGroup';
export {
  REMOTE_AGENT_CHANNEL,
  parseRemoteAgentCaps,
  type RemoteAgentFastPolicy,
} from '../../../../../../packages/device-link/src/remoteAgent';
export {
  PROVIDER_METADATA_TRUST_MS,
  isProviderAccessDeniedError,
  readProviderMetadataContinuity,
} from '../../../../../../packages/device-link/src/metadataContinuity';
