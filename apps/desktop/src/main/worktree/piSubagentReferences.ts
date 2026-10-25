import path from 'node:path';
import { app } from 'electron';
import {
  piSubagentLaunchFenceArtifact,
  piSubagentRunRoot,
} from '@cindy/maker-core/pi-subagent-runs';
import { createLogger } from '../logger';
import { createPiWorktreeReferences } from '@cindy/worktree-core/piSubagentReferences';
export const { readPiSubagentWorktreeReferences } = createPiWorktreeReferences({
  agentHome: () => path.join(app.getPath('userData'), 'pi-agent-home'),
  piSubagentLaunchFenceArtifact: (...args) => piSubagentLaunchFenceArtifact(...args),
  piSubagentRunRoot: (...args) => piSubagentRunRoot(...args),
  log: createLogger('worktreePiRefs'),
});
