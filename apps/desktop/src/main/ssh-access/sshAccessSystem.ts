/**
 * The real-machine ports of the SSH access target (sshAccessTargetCore.ts) for both launchers: sshd probe and endpoint
 * facts (sshdProbe.ts), Cindy cloud guest facts (cloudComputer.ts) and session termination (sessionTerminator.ts).
 * Tests pass their own ports instead.
 */
import os from 'node:os';
import type { SshAccessTargetPorts } from './sshAccessTargetCore.js';
import { detectCloudGuest, readCloudPublicIpv4 } from './cloudComputer.js';
import { createSessionTerminator, nodeSessionTerminatorPorts } from './sessionTerminator.js';
import { probeSshBanner, readLanAddresses, readMdnsName, readSshHostKeys, readSshdPort } from './sshdProbe.js';

export function createNodeSshAccessSystem(platform: NodeJS.Platform | string = process.platform): Pick<SshAccessTargetPorts,
  'detectCloudGuest' | 'probeSshd' | 'readEndpointFacts' | 'readPublicIpv4' | 'terminator'> {
  return {
    detectCloudGuest: () => detectCloudGuest(platform),
    probeSshd: (port) => probeSshBanner(port),
    readEndpointFacts: async () => ({
      user: os.userInfo().username,
      port: await readSshdPort(),
      lanAddresses: readLanAddresses(),
      mdnsName: readMdnsName(platform),
      hostKeys: await readSshHostKeys(),
    }),
    readPublicIpv4: () => readCloudPublicIpv4(),
    terminator: createSessionTerminator(nodeSessionTerminatorPorts(platform)),
  };
}
