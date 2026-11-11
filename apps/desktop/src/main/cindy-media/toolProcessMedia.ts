import { ingestMedia } from './ingest';
import { createToolProcessMedia, type ToolMediaPorts } from './toolProcessMediaCore';
export type { ToolMediaOrigin } from './toolProcessMediaCore';

// The SSH browser depends on maker-host. Bind it during Desktop bootstrap so
// importing durable message services cannot initialize the entire agent graph.
let remoteReader: ToolMediaPorts['materializeSshRemoteMedia'] | undefined;
export function setToolProcessMediaRemoteReader(reader: ToolMediaPorts['materializeSshRemoteMedia']): void {
  remoteReader = reader;
}
export const materializeToolProcessMedia = createToolProcessMedia({
  ingestMedia: (...args) => ingestMedia(...args),
  materializeSshRemoteMedia: (...args) => {
    if (!remoteReader) throw new Error('Remote media service is not initialized');
    return remoteReader(...args);
  },
});
